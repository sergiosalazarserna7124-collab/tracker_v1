import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { llamadas, logLlamadas, eventosHuerfanos } from "../../db/schema.js";
import {
  addContactTag,
  addContactNote,
  getAccountByLocationId,
  getAccountFullByLocationId,
  GHL_TAGS,
  type CuentaFullRow,
} from "../ghl-api.service.js";
import {
  getLatestCompletedCall,
  getCallRecordingSid,
  downloadRecording,
} from "../twilio-api.service.js";
import {
  transcribeAudio,
  classifyCall,
  mapEstadoToTag,
  type CallClassification,
} from "../ai/call-classification.service.js";
import { withRetry } from "../../utils/retry.utils.js";
import type { TwilioEventBody } from "../../schemas/webhooks/twilio.schema.js";
import type { ServiceResult } from "../../types/index.js";

// ─── Estados activos para búsqueda de registro existente ─────────────────────

const ESTADOS_ACTIVOS = ["pdte", "seguimiento", "programado", "no_contestada", "no_contestado"] as const;

// ─── Helper: calcular speed_to_lead (minutos desde fecha_evento hasta ahora) ─
// Solo aplica cuando el estado anterior era "pdte" y se va a cambiar.
// El resultado se guarda como TEXT en la BD.

function calcSpeedToLead(
  estadoAnterior: string | null,
  fechaEvento: Date | null,
  now: Date,
): string | null {
  if (estadoAnterior?.toLowerCase() !== "pdte" || !fechaEvento) return null;
  const diffMs = now.getTime() - fechaEvento.getTime();
  const minutos = Math.round(diffMs / 60_000);
  return String(Math.max(minutos, 0));
}

// ─── Helper: insertar evento en log_llamadas (best-effort, nunca bloquea) ────

interface LogEntry {
  idRegistro: number | null;
  idCuenta: number | null;
  fields: ReturnType<typeof extractFields>;
  tipoEvento: string;
  estadoResultado: string | null;
  callSid?: string | null;
  transcript?: string | null;
  iadesc?: string | null;
  speedToLead?: string | null;
  tagsInternos?: string[] | null;
}

async function insertLogEntry(entry: LogEntry): Promise<void> {
  try {
    await withRetry(
      () =>
        drizzleDb.insert(logLlamadas).values({
          id_registro: entry.idRegistro,
          id_cuenta: entry.idCuenta ?? 0,
          mail_lead: entry.fields.mailLead,
          id_user_ghl: entry.fields.idUserGhl,
          contact_id_ghl: entry.fields.contactId,
          nombre_lead: entry.fields.nombreLead,
          phone: entry.fields.phone,
          tipo_evento: entry.tipoEvento,
          estado_resultado: entry.estadoResultado,
          call_sid: entry.callSid ?? null,
          transcripcion: entry.transcript ?? null,
          ia_descripcion: entry.iadesc ?? null,
          closer_mail: entry.fields.closerMail,
          nombre_closer: entry.fields.nombreCloser,
          creativo_origen: entry.fields.creativoOrigen,
          speed_to_lead: entry.speedToLead ?? null,
          tags_internos: entry.tagsInternos ?? [],
        }),
      { label: "insertLogEntry" },
    );
  } catch (err) {
    console.error(`[Log] Error insertando en log_llamadas (tipo=${entry.tipoEvento}):`, err);
  }
}

// ─── Extracción compartida de campos del payload ──────────────────────────────

function extractFields(body: TwilioEventBody) {
  const cd = body.customData;

  const locationId = cd.locationid?.trim() || body.location?.id?.trim() || null;
  const nombreLead =
    cd.nombre?.trim() || body.full_name?.trim() || body.first_name?.trim() || "sin nombre";
  const mailLead = cd.email?.trim() || null;
  const phone = cd.numero?.trim() || body.phone?.trim() || null;
  const creativoOrigen = cd.utm?.trim() || null;
  const closerMail = cd.closermail?.trim() || null;
  const nombreCloser = cd.nombrecloser?.trim() || null;
  const contactId = body.contact_id?.trim() || null;
  const idUserGhl = cd.id_customer_ghl?.trim() || null;

  return { locationId, nombreLead, mailLead, phone, creativoOrigen, closerMail, nombreCloser, contactId, idUserGhl };
}

// ─── Lookup de cuenta (básico: sin Twilio) ───────────────────────────────────

async function resolveAccount(
  locationId: string | null,
  label: string,
): Promise<{ idCuenta: number | null; tokenGhl: string | null }> {
  if (!locationId) {
    console.warn(`[${label}] Payload sin locationId; no se puede resolver id_cuenta`);
    return { idCuenta: null, tokenGhl: null };
  }
  try {
    const account = await getAccountByLocationId(locationId);
    if (!account) {
      console.warn(`[${label}] No se encontró cuenta para locationId="${locationId}"`);
    }
    return { idCuenta: account?.id_cuenta ?? null, tokenGhl: account?.token_ghl ?? null };
  } catch (err) {
    console.error(`[${label}] Error buscando cuenta para locationId="${locationId}":`, err);
    return { idCuenta: null, tokenGhl: null };
  }
}

// ─── Lookup de cuenta (completo: con credenciales Twilio) ────────────────────

async function resolveAccountFull(
  locationId: string | null,
  label: string,
): Promise<{
  idCuenta: number | null;
  tokenGhl: string | null;
  twilioSid: string | null;
  authTwilio: string | null;
  openaiApiKey: string | null;
  embudoPersonalizado: unknown;
  promptVentas: string | null;
}> {
  const empty = { idCuenta: null, tokenGhl: null, twilioSid: null, authTwilio: null, openaiApiKey: null, embudoPersonalizado: null, promptVentas: null };
  if (!locationId) {
    console.warn(`[${label}] Payload sin locationId; no se puede resolver id_cuenta`);
    return empty;
  }
  try {
    const account: CuentaFullRow | null = await getAccountFullByLocationId(locationId);
    if (!account) {
      console.warn(`[${label}] No se encontró cuenta para locationId="${locationId}"`);
      return empty;
    }
    return {
      idCuenta: account.id_cuenta,
      tokenGhl: account.token_ghl,
      twilioSid: account.twilio_sid,
      authTwilio: account.auth_twilio,
      openaiApiKey: account.openai_api_key,
      embudoPersonalizado: account.embudo_personalizado,
      promptVentas: account.prompt_ventas,
    };
  } catch (err) {
    console.error(`[${label}] Error buscando cuenta para locationId="${locationId}":`, err);
    return empty;
  }
}

// ─── Acciones GHL compartidas: tag + nota ────────────────────────────────────

async function applyGhlTagAndNote(
  contactId: string | null,
  tokenGhl: string | null,
  tag: string,
  label: string,
): Promise<void> {
  if (!contactId || !tokenGhl) {
    if (!contactId) console.warn(`[${label}] Sin contact_id; no se puede taggear/notar en GHL`);
    if (!tokenGhl) console.warn(`[${label}] Sin token_ghl; no se puede taggear/notar en GHL`);
    return;
  }

  try {
    await addContactTag(contactId, tokenGhl, tag);
  } catch (err) {
    console.error(`[${label}] Error aplicando tag GHL para contactId="${contactId}":`, err);
  }

  try {
    await addContactNote(contactId, tokenGhl, "Llamada no contestada");
  } catch (err) {
    console.error(`[${label}] Error agregando nota GHL para contactId="${contactId}":`, err);
  }
}

// ─── followUpPath: lógica compartida para error Twilio / buzón=true ──────────

async function followUpPath(
  fields: ReturnType<typeof extractFields>,
  idCuenta: number | null,
  tokenGhl: string | null,
  callSid: string | null,
  transcript: string | null,
  iadesc: string | null,
  label: string,
): Promise<ServiceResult> {
  const { nombreLead, mailLead, phone, creativoOrigen, closerMail, nombreCloser, contactId, idUserGhl } = fields;
  const now = new Date();

  type ExistingRow = {
    id_registro: number;
    intentos_contacto: number | null;
    estado: string | null;
    fecha_evento: Date | null;
  };
  let existing: ExistingRow | null = null;

  const selectCols = {
    id_registro: llamadas.id_registro,
    intentos_contacto: llamadas.intentos_contacto,
    estado: llamadas.estado,
    fecha_evento: llamadas.fecha_evento,
  };

  // Prioridad 1: buscar por mail_lead
  if (mailLead) {
    try {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select(selectCols)
            .from(llamadas)
            .where(
              and(
                sql`LOWER(${llamadas.mail_lead}) = LOWER(${mailLead})`,
                idCuenta ? eq(llamadas.id_cuenta, idCuenta) : undefined,
                or(
                  inArray(llamadas.estado, [...ESTADOS_ACTIVOS]),
                  isNull(llamadas.estado),
                ),
              ),
            )
            .orderBy(desc(llamadas.fecha_evento))
            .limit(1),
        { label: `${label}/selectByMail` },
      );

      existing = rows[0] ?? null;
    } catch (err) {
      console.error(`[${label}] Error buscando registro existente para mail="${mailLead}":`, err);
    }
  }

  // Prioridad 2: fallback por id_user_ghl si mail_lead no encontró nada
  if (!existing && idUserGhl) {
    try {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select(selectCols)
            .from(llamadas)
            .where(
              and(
                eq(llamadas.id_user_ghl, idUserGhl),
                idCuenta ? eq(llamadas.id_cuenta, idCuenta) : undefined,
                or(
                  inArray(llamadas.estado, [...ESTADOS_ACTIVOS]),
                  isNull(llamadas.estado),
                ),
              ),
            )
            .orderBy(desc(llamadas.fecha_evento))
            .limit(1),
        { label: `${label}/selectByGhlId` },
      );

      existing = rows[0] ?? null;
    } catch (err) {
      console.error(`[${label}] Error buscando registro por id_user_ghl="${idUserGhl}":`, err);
    }
  }

  let idRegistro: number | null = null;

  if (existing) {
    const stl = calcSpeedToLead(existing.estado, existing.fecha_evento, now);

    try {
      await withRetry(
        () =>
          drizzleDb
            .update(llamadas)
            .set({
              nombre_lead: nombreLead,
              estado: "seguimiento",
              closer_mail: closerMail,
              nombre_closer: nombreCloser,
              fecha_y_hora_de_seguimiento: now,
              intentos_contacto: (existing!.intentos_contacto ?? 0) + 1,
              ...(callSid && { callsid: callSid }),
              ...(transcript && { trancription: transcript }),
              ...(iadesc && { iadescripcion: iadesc }),
              ...(idUserGhl && { id_user_ghl: idUserGhl }),
              ...(stl !== null && { speed_to_lead: stl }),
            })
            .where(eq(llamadas.id_registro, existing!.id_registro)),
        { label: `${label}/update` },
      );

      idRegistro = existing.id_registro;
    } catch (err) {
      console.error(`[${label}] Error actualizando registro id=${existing.id_registro}:`, err);
      return { success: false, error: "Database error while updating call record" };
    }
  } else {
    try {
      const [inserted] = await withRetry(
        () =>
          drizzleDb
            .insert(llamadas)
            .values({
              fecha_evento: now,
              id_cuenta: idCuenta,
              nombre_lead: nombreLead,
              estado: "seguimiento",
              mail_lead: mailLead,
              phone_raw_format: phone,
              creativo_origen: creativoOrigen,
              closer_mail: closerMail,
              nombre_closer: nombreCloser,
              fecha_y_hora_de_seguimiento: now,
              intentos_contacto: 1,
              fecha_primera_llamada: now,
              speed_to_lead: "0",
              trancription: transcript,
              callsid: callSid,
              iadescripcion: iadesc,
              id_user_ghl: idUserGhl,
            })
            .returning({ id_registro: llamadas.id_registro }),
        { label: `${label}/insert` },
      );

      idRegistro = inserted?.id_registro ?? null;
    } catch (err) {
      console.error(`[${label}] Error insertando registro para mail="${mailLead}":`, err);
      return { success: false, error: "Database error while inserting call record" };
    }
  }

  await applyGhlTagAndNote(contactId, tokenGhl, GHL_TAGS.no_contestada_llamada, label);

  // Determinar tipo_evento para el log según contexto
  const tipoEvento = label.includes("buzon")
    ? "buzon"
    : "no_contesto";

  await insertLogEntry({
    idRegistro,
    idCuenta,
    fields,
    tipoEvento,
    estadoResultado: "seguimiento",
    callSid,
    transcript,
    iadesc,
    speedToLead: existing ? calcSpeedToLead(existing.estado, existing.fecha_evento, now) : "0",
  });

  return {
    success: true,
    data: {
      id_registro: idRegistro,
      action: existing ? "updated" : "created",
      path: "followUp",
    },
  };
}

// ─── Helper: guardar evento huérfano (lead no-identificable) ─────────────────

async function saveOrphanEvent(
  body: TwilioEventBody,
  idCuenta: number | null,
  label: string,
): Promise<ServiceResult> {
  console.warn(`[${label}] Lead no identificable (sin email, contact_id ni id_user_ghl). Saving as orphan.`);
  try {
    await drizzleDb.insert(eventosHuerfanos).values({
      id_cuenta: idCuenta,
      origen: "twilio",
      motivo: "Lead no identificable: sin email, sin contact_id, sin id_user_ghl",
      payload_original: body,
      estado: "pendiente",
    });
  } catch (orphanErr) {
    console.error(`[${label}] Error guardando evento huérfano:`, orphanErr);
  }
  return { success: true, data: { path: "orphan" } };
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /webhooks/twilio — Llamada pendiente
// ═══════════════════════════════════════════════════════════════════════════════

export async function processTwilioWebhook(body: TwilioEventBody): Promise<ServiceResult> {
  const fields = extractFields(body);

  if (!fields.mailLead && !fields.contactId && !fields.idUserGhl) {
    const { idCuenta } = await resolveAccount(fields.locationId, "Twilio");
    return saveOrphanEvent(body, idCuenta, "Twilio");
  }

  const { idCuenta } = await resolveAccount(fields.locationId, "Twilio");

  try {
    const [inserted] = await withRetry(
      () =>
        drizzleDb
          .insert(llamadas)
          .values({
            fecha_evento: new Date(),
            id_cuenta: idCuenta,
            nombre_lead: fields.nombreLead,
            estado: "pdte",
            mail_lead: fields.mailLead,
            phone_raw_format: fields.phone,
            creativo_origen: fields.creativoOrigen,
            closer_mail: fields.closerMail,
            nombre_closer: fields.nombreCloser,
            intentos_contacto: 0,
            fecha_y_hora_de_seguimiento: null,
            speed_to_lead: null,
            fecha_primera_llamada: null,
            trancription: null,
            callsid: null,
            iadescripcion: null,
            id_user_ghl: fields.idUserGhl,
          })
          .returning({ id_registro: llamadas.id_registro }),
      { label: "Twilio/insertPdte" },
    );

    const idRegistro = inserted?.id_registro ?? null;

    await insertLogEntry({
      idRegistro,
      idCuenta,
      fields,
      tipoEvento: "pdte",
      estadoResultado: "pdte",
    });

    return { success: true, data: { id_registro: idRegistro } };
  } catch (err) {
    console.error("[Twilio] Error insertando registro de llamada:", err);
    return { success: false, error: "Database error while inserting call record" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /webhooks/twilio/no-answer — Llamada no contestada
// ═══════════════════════════════════════════════════════════════════════════════

export async function processNoAnswerCall(body: TwilioEventBody): Promise<ServiceResult> {
  const fields = extractFields(body);

  if (!fields.mailLead && !fields.contactId && !fields.idUserGhl) {
    const { idCuenta } = await resolveAccount(fields.locationId, "NoAnswer");
    return saveOrphanEvent(body, idCuenta, "NoAnswer");
  }

  const { idCuenta, tokenGhl } = await resolveAccount(fields.locationId, "NoAnswer");

  return followUpPath(fields, idCuenta, tokenGhl, null, null, null, "NoAnswer");
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /webhooks/twilio/effective — Llamada efectiva (Twilio + Whisper + IA)
// ═══════════════════════════════════════════════════════════════════════════════

export async function processEffectiveCall(body: TwilioEventBody): Promise<ServiceResult> {
  const fields = extractFields(body);

  if (!fields.mailLead && !fields.contactId && !fields.idUserGhl) {
    const { idCuenta } = await resolveAccount(fields.locationId, "Effective");
    return saveOrphanEvent(body, idCuenta, "Effective");
  }

  const { idCuenta, tokenGhl, twilioSid, authTwilio, openaiApiKey, embudoPersonalizado, promptVentas } =
    await resolveAccountFull(fields.locationId, "Effective");

  // ── Fase 1: Pipeline Twilio (calls → recordings → download) ───────────────

  if (!twilioSid || !authTwilio) {
    console.warn("[Effective] Sin credenciales Twilio; procesando como followUp");
    return followUpPath(fields, idCuenta, tokenGhl, null, null, null, "Effective");
  }

  if (!fields.phone) {
    console.warn("[Effective] Sin teléfono en el payload; procesando como followUp");
    return followUpPath(fields, idCuenta, tokenGhl, null, null, null, "Effective");
  }

  let callSid: string | null = null;
  let audioBuffer: Buffer | null = null;

  try {
    const call = await getLatestCompletedCall(twilioSid, authTwilio, fields.phone);
    if (!call) {
      console.warn(`[Effective] No se encontró llamada completada para phone="${fields.phone}"`);
      return followUpPath(fields, idCuenta, tokenGhl, null, null, null, "Effective");
    }

    callSid = call.callSid;

    const recordingSid = await getCallRecordingSid(
      call.accountSid,
      call.callSid,
      twilioSid,
      authTwilio,
      call.parentCallSid,
    );
    if (!recordingSid) {
      console.warn(`[Effective] Sin recordings para callSid="${call.callSid}"`);
      return followUpPath(fields, idCuenta, tokenGhl, callSid, null, null, "Effective");
    }

    audioBuffer = await downloadRecording(call.accountSid, recordingSid, twilioSid, authTwilio);
  } catch (err) {
    console.error("[Effective] Error en pipeline Twilio:", err);
    return followUpPath(fields, idCuenta, tokenGhl, callSid, null, null, "Effective");
  }

  if (!audioBuffer) {
    return followUpPath(fields, idCuenta, tokenGhl, callSid, null, null, "Effective");
  }

  // Pre-flight: si el audio es demasiado pequeño probablemente no tiene contenido
  // útil (grabación vacía o cortada). Whisper devolvería un error o transcripción
  // vacía; cortamos aquí para no consumir la API innecesariamente.
  const WHISPER_MIN_BYTES = 5_000; // ~5 KB
  if (audioBuffer.length < WHISPER_MIN_BYTES) {
    console.warn(
      `[Effective] Audio demasiado pequeño (${audioBuffer.length} bytes < ${WHISPER_MIN_BYTES}); procesando como followUp`,
    );
    return followUpPath(fields, idCuenta, tokenGhl, callSid, null, null, "Effective");
  }

  // ── Fase 2: Whisper transcripción ──────────────────────────────────────────

  let transcript: string;
  try {
    transcript = await transcribeAudio(audioBuffer, openaiApiKey);
  } catch (err) {
    console.error("[Effective] Error transcribiendo audio con Whisper:", err);
    return followUpPath(fields, idCuenta, tokenGhl, callSid, null, null, "Effective");
  }

  if (!transcript.trim()) {
    console.warn("[Effective] Whisper devolvió transcripción vacía");
    return followUpPath(fields, idCuenta, tokenGhl, callSid, null, null, "Effective");
  }

  // ── Fase 3: Clasificación IA ───────────────────────────────────────────────

  let classification: CallClassification;
  try {
    classification = await classifyCall(transcript, openaiApiKey, embudoPersonalizado, promptVentas);
  } catch (err) {
    console.error("[Effective] Error clasificando llamada con IA:", err);
    return followUpPath(fields, idCuenta, tokenGhl, callSid, transcript, null, "Effective");
  }

  // ── Fase 4: Routing según resultado IA ─────────────────────────────────────

  if (classification.buzon === true || classification.buzon === null) {
    return followUpPath(
      fields,
      idCuenta,
      tokenGhl,
      callSid,
      transcript,
      classification.iadesc,
      "Effective/buzon",
    );
  }

  // ── Fase 5: effectivePath (buzon=false) ────────────────────────────────────

  return effectivePath(
    fields,
    idCuenta,
    tokenGhl,
    callSid,
    transcript,
    classification,
  );
}

// ─── effectivePath: la persona contestó, clasificada por IA ──────────────────

async function effectivePath(
  fields: ReturnType<typeof extractFields>,
  idCuenta: number | null,
  tokenGhl: string | null,
  callSid: string | null,
  transcript: string,
  classification: CallClassification,
): Promise<ServiceResult> {
  const { nombreLead, mailLead, phone, creativoOrigen, closerMail, nombreCloser, contactId, idUserGhl } = fields;
  const now = new Date();
  const aiEstado = classification.estado ?? "seguimiento";
  const iadesc = classification.iadesc ?? null;
  const tagsInternos = classification.tags_internos ?? [];

  // Buscar el registro MAS RECIENTE (sin filtrar por estado)
  type ExistingRow = {
    id_registro: number;
    intentos_contacto: number | null;
    estado: string | null;
    fecha_evento: Date | null;
  };
  let existing: ExistingRow | null = null;

  const selectCols = {
    id_registro: llamadas.id_registro,
    intentos_contacto: llamadas.intentos_contacto,
    estado: llamadas.estado,
    fecha_evento: llamadas.fecha_evento,
  };

  // Prioridad 1: buscar por mail_lead
  if (mailLead) {
    try {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select(selectCols)
            .from(llamadas)
            .where(
              and(
                sql`LOWER(${llamadas.mail_lead}) = LOWER(${mailLead})`,
                idCuenta ? eq(llamadas.id_cuenta, idCuenta) : undefined,
              ),
            )
            .orderBy(desc(llamadas.id_registro))
            .limit(1),
        { label: "effectivePath/selectByMail" },
      );

      existing = rows[0] ?? null;
    } catch (err) {
      console.error(`[Effective] Error buscando registro para mail="${mailLead}":`, err);
    }
  }

  // Prioridad 2: fallback por id_user_ghl
  if (!existing && idUserGhl) {
    try {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select(selectCols)
            .from(llamadas)
            .where(
              and(
                eq(llamadas.id_user_ghl, idUserGhl),
                idCuenta ? eq(llamadas.id_cuenta, idCuenta) : undefined,
              ),
            )
            .orderBy(desc(llamadas.id_registro))
            .limit(1),
        { label: "effectivePath/selectByGhlId" },
      );

      existing = rows[0] ?? null;
    } catch (err) {
      console.error(`[Effective] Error buscando registro por id_user_ghl="${idUserGhl}":`, err);
    }
  }

  // Determinar si el estado del registro existente es "activo" para decidir UPDATE vs INSERT
  const estadoActivo =
    existing &&
    (existing.estado === null ||
      existing.estado === "" ||
      ESTADOS_ACTIVOS.some((e) => existing!.estado?.toLowerCase().includes(e)));

  let idRegistro: number | null = null;

  if (existing && estadoActivo) {
    const stl = calcSpeedToLead(existing.estado, existing.fecha_evento, now);

    try {
      await withRetry(
        () =>
          drizzleDb
            .update(llamadas)
            .set({
              nombre_lead: nombreLead,
              estado: aiEstado,
              closer_mail: closerMail,
              nombre_closer: nombreCloser,
              fecha_y_hora_de_seguimiento: now,
              intentos_contacto: (existing!.intentos_contacto ?? 0) + 1,
              trancription: transcript,
              iadescripcion: iadesc,
              tags_internos: tagsInternos,
              ...(callSid && { callsid: callSid }),
              ...(idUserGhl && { id_user_ghl: idUserGhl }),
              ...(stl !== null && { speed_to_lead: stl }),
            })
            .where(eq(llamadas.id_registro, existing!.id_registro)),
        { label: "effectivePath/update" },
      );

      idRegistro = existing.id_registro;
    } catch (err) {
      console.error(`[Effective] Error actualizando registro id=${existing.id_registro}:`, err);
      return { success: false, error: "Database error while updating call record" };
    }
  } else {
    try {
      const [inserted] = await withRetry(
        () =>
          drizzleDb
            .insert(llamadas)
            .values({
              fecha_evento: now,
              id_cuenta: idCuenta,
              nombre_lead: nombreLead,
              estado: aiEstado,
              mail_lead: mailLead,
              phone_raw_format: phone,
              creativo_origen: creativoOrigen,
              closer_mail: closerMail,
              nombre_closer: nombreCloser,
              fecha_y_hora_de_seguimiento: now,
              intentos_contacto: 1,
              fecha_primera_llamada: now,
              speed_to_lead: "0",
              trancription: transcript,
              callsid: callSid,
              iadescripcion: iadesc,
              id_user_ghl: idUserGhl,
              tags_internos: tagsInternos,
            })
            .returning({ id_registro: llamadas.id_registro }),
        { label: "effectivePath/insert" },
      );

      idRegistro = inserted?.id_registro ?? null;
    } catch (err) {
      console.error(`[Effective] Error insertando registro para mail="${mailLead}":`, err);
      return { success: false, error: "Database error while inserting call record" };
    }
  }

  // Tag dinámico
  const tag = mapEstadoToTag(aiEstado);
  if (contactId && tokenGhl) {
    try {
      await addContactTag(contactId, tokenGhl, tag);
    } catch (err) {
      console.error(`[Effective] Error aplicando tag GHL para contactId="${contactId}":`, err);
    }

    // Nota 1: Descripción IA
    if (iadesc) {
      try {
        await addContactNote(
          contactId,
          tokenGhl,
          `📞 Llamada Telefónica — Análisis IA\n\n${iadesc}`,
        );
      } catch (err) {
        console.error(`[Effective] Error agregando nota IA en GHL:`, err);
      }
    }

    // Nota 2: Transcripción completa
    if (transcript) {
      try {
        await addContactNote(
          contactId,
          tokenGhl,
          `📞 Llamada Telefónica — Transcripción\n\n${transcript}`,
        );
      } catch (err) {
        console.error(`[Effective] Error agregando nota transcripción en GHL:`, err);
      }
    }
  } else {
    if (!contactId) console.warn(`[Effective] Sin contact_id; no se puede taggear/notar en GHL`);
    if (!tokenGhl) console.warn(`[Effective] Sin token_ghl; no se puede taggear/notar en GHL`);
  }

  const stlForLog = existing
    ? calcSpeedToLead(existing.estado, existing.fecha_evento, now)
    : "0";

  await insertLogEntry({
    idRegistro,
    idCuenta,
    fields,
    tipoEvento: `efectiva_${aiEstado}`,
    estadoResultado: aiEstado,
    callSid,
    transcript,
    iadesc,
    speedToLead: stlForLog,
    tagsInternos,
  });

  return {
    success: true,
    data: {
      id_registro: idRegistro,
      action: existing && estadoActivo ? "updated" : "created",
      path: "effective",
      estado: aiEstado,
      buzon: false,
    },
  };
}

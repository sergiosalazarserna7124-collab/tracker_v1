import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { llamadas, logLlamadas, eventosHuerfanos, cuentas, agendas } from "../../db/schema.js";
import {
  addContactNote,
  getAccountByLocationId,
  getAccountFullByLocationId,
  safeAddContactTag,
  safeAddContactTags,
  searchOpportunityByContact,
  updateOpportunityStage,
  parseFunnelStageMap,
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
import { generateLlamadaAnalysisText, diarizarTranscripcion } from "../ai/call-analysis.service.js";
import { evaluateReglas } from "../ai/reglas-evaluator.service.js";
import { withRetry } from "../../utils/retry.utils.js";
import { markTokenInvalid, savePendingNote, savePendingTag } from "../ghl-token-guard.service.js";
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
  leadEmbudoPersonalizado?: Record<string, unknown> | null;
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
          ...(entry.leadEmbudoPersonalizado && { lead_embudo_personalizado: entry.leadEmbudoPersonalizado }),
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

  // Prioridad: customData.locationid → body.location.id (fallback si customData tiene typo)
  const locationId = cd.locationid?.trim() || body.location?.id?.trim() || null;
  // Fallback separado: usado en resolveAccount si el locationId primario no matchea ninguna cuenta
  const locationIdFallback = body.location?.id?.trim() || null;
  const nombreLead =
    cd.nombre?.trim() || body.full_name?.trim() || body.first_name?.trim() || "sin nombre";
  // cd.email a veces contiene el contact_id de GHL (no un email real) — priorizar body.email
  const bodyEmail = (body as Record<string, unknown>).email as string | undefined;
  const mailLead = bodyEmail?.trim() || (cd.email?.includes("@") ? cd.email.trim() : null);
  const phone = cd.numero?.trim() || body.phone?.trim() || null;
  const creativoOrigen = cd.utm?.trim() || null;
  // Appointment owner: leer el email del closer/asesor de la CITA en orden de prioridad
  const cdRaw = cd as Record<string, unknown>;
  const closerMail =
    (typeof cdRaw.appointmentowneremail === "string" ? cdRaw.appointmentowneremail.trim() : null) ||
    (typeof cdRaw.appointment_owner_email === "string" ? cdRaw.appointment_owner_email.trim() : null) ||
    (typeof cdRaw.appointmentowner === "string" ? cdRaw.appointmentowner.trim() : null) ||
    cd.closermail?.trim() ||
    body.user?.email?.trim() ||
    null;
  const nombreCloser = cd.nombrecloser?.trim() || `${body.user?.firstName ?? ""} ${body.user?.lastName ?? ""}`.trim() || null;
  // contact_id: viene en body.contact_id o en cd.email cuando es un ID GHL (sin @)
  const contactId = body.contact_id?.trim() || (!cd.email?.includes("@") ? cd.email?.trim() : null) || null;
  const idUserGhl = cd.id_customer_ghl?.trim() || null;
  // Transcripción ya generada (cuentas GHL sin Twilio)
  const preTranscript = cd.transcript?.trim() || null;

  return { locationId, locationIdFallback, nombreLead, mailLead, phone, creativoOrigen, closerMail, nombreCloser, contactId, idUserGhl, preTranscript };
}

// ─── Lookup de cuenta (básico: sin Twilio) ───────────────────────────────────

async function resolveAccount(
  locationId: string | null,
  label: string,
  locationIdFallback?: string | null,
): Promise<{ idCuenta: number | null; tokenGhl: string | null; isCancelled: boolean }> {
  if (!locationId) {
    console.warn(`[${label}] Payload sin locationId; no se puede resolver id_cuenta`);
    return { idCuenta: null, tokenGhl: null, isCancelled: false };
  }
  try {
    const account = await getAccountByLocationId(locationId);
    if (account) {
      if (account.estado_cuenta === "cancelado") {
        console.info(`[${label}] Cuenta cancelada (id=${account.id_cuenta}) — webhook descartado silenciosamente`);
        return { idCuenta: null, tokenGhl: null, isCancelled: true };
      }
      return { idCuenta: account.id_cuenta, tokenGhl: account.token_ghl ?? null, isCancelled: false };
    }
    // Fallback: intentar con body.location.id si customData.locationid no matcheó
    if (locationIdFallback && locationIdFallback !== locationId) {
      const fallbackAccount = await getAccountByLocationId(locationIdFallback);
      if (fallbackAccount) {
        if (fallbackAccount.estado_cuenta === "cancelado") {
          console.info(`[${label}] Cuenta cancelada (id=${fallbackAccount.id_cuenta}) — webhook descartado silenciosamente`);
          return { idCuenta: null, tokenGhl: null, isCancelled: true };
        }
        console.info(`[${label}] Cuenta encontrada por fallback location.id="${locationIdFallback}" (customData.locationid="${locationId}" no matcheó)`);
        return { idCuenta: fallbackAccount.id_cuenta, tokenGhl: fallbackAccount.token_ghl ?? null, isCancelled: false };
      }
    }
    console.warn(`[${label}] No se encontró cuenta para locationId="${locationId}"`);
    return { idCuenta: null, tokenGhl: null, isCancelled: false };
  } catch (err) {
    console.error(`[${label}] Error buscando cuenta para locationId="${locationId}":`, err);
    return { idCuenta: null, tokenGhl: null, isCancelled: false };
  }
}

// ─── Lookup de cuenta (completo: con credenciales Twilio) ────────────────────

async function resolveAccountFull(
  locationId: string | null,
  label: string,
  locationIdFallback?: string | null,
): Promise<{
  idCuenta: number | null;
  tokenGhl: string | null;
  twilioSid: string | null;
  authTwilio: string | null;
  openaiApiKey: string | null;
  embudoPersonalizado: unknown;
  promptVentas: string | null;
  promptLlamadas: string | null;
  reglasEtiquetas: unknown;
  isCancelled: boolean;
}> {
  const empty = { idCuenta: null, tokenGhl: null, twilioSid: null, authTwilio: null, openaiApiKey: null, embudoPersonalizado: null, promptVentas: null, promptLlamadas: null, reglasEtiquetas: null, isCancelled: false };
  if (!locationId) {
    console.warn(`[${label}] Payload sin locationId; no se puede resolver id_cuenta`);
    return empty;
  }
  try {
    let account: CuentaFullRow | null = await getAccountFullByLocationId(locationId);
    if (!account && locationIdFallback && locationIdFallback !== locationId) {
      account = await getAccountFullByLocationId(locationIdFallback);
      if (account) {
        console.info(`[${label}] Cuenta encontrada por fallback location.id="${locationIdFallback}" (customData.locationid="${locationId}" no matcheó)`);
      }
    }
    if (!account) {
      console.warn(`[${label}] No se encontró cuenta para locationId="${locationId}"`);
      return empty;
    }
    if (account.estado_cuenta === "cancelado") {
      console.info(`[${label}] Cuenta cancelada (id=${account.id_cuenta}) — webhook descartado silenciosamente`);
      return { ...empty, isCancelled: true };
    }
    return {
      idCuenta: account.id_cuenta,
      tokenGhl: account.token_ghl,
      twilioSid: account.twilio_sid,
      authTwilio: account.auth_twilio,
      openaiApiKey: account.openai_api_key,
      embudoPersonalizado: account.embudo_personalizado,
      promptVentas: account.prompt_ventas,
      promptLlamadas: account.prompt_llamadas,
      reglasEtiquetas: account.reglas_etiquetas,
      isCancelled: false,
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
  locationId?: string | null,
  idCuenta?: number | null,
): Promise<void> {
  if (!contactId || !tokenGhl) {
    if (!contactId) console.warn(`[${label}] Sin contact_id; no se puede taggear/notar en GHL`);
    if (!tokenGhl) console.warn(`[${label}] Sin token_ghl; no se puede taggear/notar en GHL`);
    return;
  }

  try {
    await safeAddContactTag(contactId, tokenGhl, tag, locationId);
  } catch (err) {
    const isInvalid = (err as Error & { isTokenInvalid?: boolean }).isTokenInvalid;
    if (isInvalid && idCuenta) {
      await markTokenInvalid(idCuenta);
      await savePendingTag(idCuenta, contactId, tag, String(err));
    } else {
      console.error(`[${label}] Error aplicando tag GHL para contactId="${contactId}":`, err);
    }
  }

  try {
    await addContactNote(contactId, tokenGhl, "Llamada no contestada");
  } catch (err) {
    const isInvalid = (err as Error & { isTokenInvalid?: boolean }).isTokenInvalid;
    if (isInvalid && idCuenta) {
      await savePendingNote(idCuenta, contactId, "Llamada no contestada", String(err));
    } else {
      console.error(`[${label}] Error agregando nota GHL para contactId="${contactId}":`, err);
    }
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

  // Prioridad 3: fallback por ghl_contact_id (contact_id del payload)
  // Esto resuelve el caso de Grupo Mexa: no-answer llega sin id_user_ghl pero sí con contact_id
  if (!existing && contactId) {
    try {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select(selectCols)
            .from(llamadas)
            .where(
              and(
                eq(llamadas.ghl_contact_id, contactId),
                idCuenta ? eq(llamadas.id_cuenta, idCuenta) : undefined,
                or(
                  inArray(llamadas.estado, [...ESTADOS_ACTIVOS]),
                  isNull(llamadas.estado),
                ),
              ),
            )
            .orderBy(desc(llamadas.fecha_evento))
            .limit(1),
        { label: `${label}/selectByContactId` },
      );

      existing = rows[0] ?? null;
      if (existing) console.log(`[${label}] Encontrado por ghl_contact_id="${contactId}" id_registro=${existing.id_registro}`);
    } catch (err) {
      console.error(`[${label}] Error buscando registro por ghl_contact_id="${contactId}":`, err);
    }
  }

  // Prioridad 4: fallback por teléfono (último recurso)
  if (!existing && phone) {
    try {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select(selectCols)
            .from(llamadas)
            .where(
              and(
                eq(llamadas.phone_raw_format, phone),
                idCuenta ? eq(llamadas.id_cuenta, idCuenta) : undefined,
                or(
                  inArray(llamadas.estado, [...ESTADOS_ACTIVOS]),
                  isNull(llamadas.estado),
                ),
              ),
            )
            .orderBy(desc(llamadas.fecha_evento))
            .limit(1),
        { label: `${label}/selectByPhone` },
      );

      existing = rows[0] ?? null;
      if (existing) console.log(`[${label}] Encontrado por phone="${phone}" id_registro=${existing.id_registro}`);
    } catch (err) {
      console.error(`[${label}] Error buscando registro por phone="${phone}":`, err);
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
              estado: "no_contestada",
              closer_mail: closerMail,
              nombre_closer: nombreCloser,
              fecha_y_hora_de_seguimiento: now,
              intentos_contacto: (existing!.intentos_contacto ?? 0) + 1,
              ...((existing!.intentos_contacto ?? 0) === 0 && { fecha_primera_llamada: now }),
              ...(callSid && { callsid: callSid }),
              ...(transcript && { trancription: transcript }),
              ...(iadesc && { iadescripcion: iadesc }),
              ...(idUserGhl && { id_user_ghl: idUserGhl }),
              ...(contactId && { ghl_contact_id: contactId }),
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
              estado: "no_contestada",
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
              ghl_contact_id: contactId,
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

  await applyGhlTagAndNote(contactId, tokenGhl, GHL_TAGS.no_contestada_llamada, label, fields.locationId, idCuenta);

  const tipoEvento = label.includes("buzon")
    ? "buzon"
    : "no_contesto";

  await insertLogEntry({
    idRegistro,
    idCuenta,
    fields,
    tipoEvento,
    estadoResultado: "no_contestada",
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

  const { idCuenta, isCancelled } = await resolveAccount(fields.locationId, "Twilio", fields.locationIdFallback);
  if (isCancelled) return { success: true };

  if (!fields.mailLead && !fields.contactId && !fields.idUserGhl && !fields.phone) {
    return saveOrphanEvent(body, idCuenta, "Twilio");
  }

  // Idempotency: buscar registro PDTE existente antes de crear uno nuevo.
  // GHL puede enviar el mismo webhook Twilio múltiples veces para la misma llamada
  // (reintentos, eventos duplicados). Sin este check, cada disparo crea un pdte
  // separado que luego se convierte en un seguimiento independiente — eso es lo que
  // genera los "leads duplicados" que ve el cliente.
  // Buscamos solo en estado "pdte": si ya pasó el ciclo (seguimiento, no_contestado…),
  // la siguiente llamada real debe crear un nuevo pdte para el nuevo ciclo.
  try {
    let existingPdte: { id_registro: number } | null = null;
    const accountCond = idCuenta ? eq(llamadas.id_cuenta, idCuenta) : undefined;

    // 1. Por email (más confiable)
    if (fields.mailLead) {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select({ id_registro: llamadas.id_registro })
            .from(llamadas)
            .where(and(sql`LOWER(${llamadas.mail_lead}) = LOWER(${fields.mailLead!})`, accountCond, eq(llamadas.estado, "pdte")))
            .limit(1),
        { label: "Twilio/Pending/checkByEmail" },
      );
      existingPdte = rows[0] ?? null;
    }

    // 2. Por teléfono
    if (!existingPdte && fields.phone) {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select({ id_registro: llamadas.id_registro })
            .from(llamadas)
            .where(and(eq(llamadas.phone_raw_format, fields.phone!), accountCond, eq(llamadas.estado, "pdte")))
            .limit(1),
        { label: "Twilio/Pending/checkByPhone" },
      );
      existingPdte = rows[0] ?? null;
    }

    // 3. Por GHL contact_id
    if (!existingPdte && fields.contactId) {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select({ id_registro: llamadas.id_registro })
            .from(llamadas)
            .where(and(eq(llamadas.ghl_contact_id, fields.contactId!), accountCond, eq(llamadas.estado, "pdte")))
            .limit(1),
        { label: "Twilio/Pending/checkByContactId" },
      );
      existingPdte = rows[0] ?? null;
    }

    // 4. Por GHL user_id (último recurso)
    if (!existingPdte && fields.idUserGhl) {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select({ id_registro: llamadas.id_registro })
            .from(llamadas)
            .where(and(eq(llamadas.id_user_ghl, fields.idUserGhl!), accountCond, eq(llamadas.estado, "pdte")))
            .limit(1),
        { label: "Twilio/Pending/checkByGhlUserId" },
      );
      existingPdte = rows[0] ?? null;
    }

    if (existingPdte) {
      console.info(`[Twilio] Registro PDTE ya existe (id=${existingPdte.id_registro}), ignorando webhook duplicado.`);
      return { success: true, data: { id_registro: existingPdte.id_registro, action: "already_exists" } };
    }

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
            ghl_contact_id: fields.contactId,
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

  const { idCuenta, tokenGhl, isCancelled } = await resolveAccount(fields.locationId, "NoAnswer", fields.locationIdFallback);
  if (isCancelled) return { success: true };

  if (!fields.mailLead && !fields.contactId && !fields.idUserGhl) {
    return saveOrphanEvent(body, idCuenta, "NoAnswer");
  }

  return followUpPath(fields, idCuenta, tokenGhl, null, null, null, "NoAnswer");
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /webhooks/twilio/effective — Llamada efectiva (Twilio + Whisper + IA)
// ═══════════════════════════════════════════════════════════════════════════════

export async function processEffectiveCall(body: TwilioEventBody): Promise<ServiceResult> {
  const fields = extractFields(body);

  const { idCuenta, tokenGhl, twilioSid, authTwilio, openaiApiKey, embudoPersonalizado, promptVentas, promptLlamadas, reglasEtiquetas, isCancelled } =
    await resolveAccountFull(fields.locationId, "Effective", fields.locationIdFallback);
  if (isCancelled) return { success: true };

  if (!fields.mailLead && !fields.contactId && !fields.idUserGhl) {
    return saveOrphanEvent(body, idCuenta, "Effective");
  }

  // ── Bypass Twilio: transcripción ya viene en el payload (cuentas GHL sin Twilio) ──
  if (fields.preTranscript) {
    console.log("[Effective] Transcript pre-generado recibido — saltando pipeline Twilio/Whisper");
    let classification: CallClassification;
    try {
      classification = await classifyCall(fields.preTranscript, openaiApiKey, embudoPersonalizado, promptVentas, promptLlamadas, idCuenta);
    } catch (err) {
      console.error("[Effective/GHL] Error clasificando con IA:", err);
      return followUpPath(fields, idCuenta, tokenGhl, null, fields.preTranscript, null, "Effective/GHL");
    }
    if (classification.buzon === true || classification.buzon === null) {
      return followUpPath(fields, idCuenta, tokenGhl, null, fields.preTranscript, classification.iadesc, "Effective/GHL/buzon");
    }
    return effectivePath(fields, idCuenta, tokenGhl, null, fields.preTranscript, classification, openaiApiKey, embudoPersonalizado, promptVentas, reglasEtiquetas, promptLlamadas);
  }

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
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("Recording download responded 404")) {
      console.warn("[Effective] Recording aún no procesado por Twilio (404) — skip sin actualizar GHL ni BD");
      return { success: true, data: { path: "skip-recording-not-ready" } };
    }
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
    transcript = await transcribeAudio(audioBuffer, openaiApiKey, idCuenta);
    // Post-process: diarizar si Whisper devolvió texto plano (sin speaker labels)
    // Se hace de forma best-effort — si falla, se usa el transcript plano
    if (transcript.trim()) {
      transcript = await diarizarTranscripcion(transcript, openaiApiKey, idCuenta);
    }
  } catch (err) {
    console.error("[Effective] Error transcribiendo audio con Whisper:", err);
    return followUpPath(fields, idCuenta, tokenGhl, callSid, null, null, "Effective");
  }

  if (!transcript.trim()) {
    console.warn("[Effective] Whisper devolvió transcripción vacía");
    return followUpPath(fields, idCuenta, tokenGhl, callSid, null, null, "Effective");
  }

  // Pre-flight: transcripción demasiado corta → buzón de voz o llamada sin
  // conversación real (ej: "Bueno, se le quedó?" / mensaje de screening iPhone).
  // Umbral de 80 chars: cualquier conversación real tiene al menos eso.
  const MIN_TRANSCRIPT_CHARS = 80;
  if (transcript.trim().length < MIN_TRANSCRIPT_CHARS) {
    console.warn(
      `[Effective] Transcripción muy corta (${transcript.trim().length} chars < ${MIN_TRANSCRIPT_CHARS}); clasificando como seguimiento sin consumir IA`,
    );
    return followUpPath(fields, idCuenta, tokenGhl, callSid, transcript, "Transcripción demasiado corta para ser una conversación real.", "Effective/short-transcript");
  }

  // ── Fase 3: Clasificación IA ───────────────────────────────────────────────

  let classification: CallClassification;
  try {
    classification = await classifyCall(transcript, openaiApiKey, embudoPersonalizado, promptVentas, promptLlamadas, idCuenta);
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
    openaiApiKey,
    embudoPersonalizado,
    promptVentas,
    reglasEtiquetas,
    promptLlamadas,
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
  openaiApiKey?: string | null,
  embudoPersonalizado?: unknown,
  promptVentas?: string | null,
  reglasEtiquetas?: unknown,
  promptLlamadas?: string | null,
): Promise<ServiceResult> {
  const { nombreLead, mailLead, phone, creativoOrigen, closerMail, nombreCloser, contactId, idUserGhl } = fields;
  const now = new Date();
  const aiEstado = classification.estado ?? "seguimiento";

  // Generar análisis enriquecido + evaluar reglas en paralelo (son independientes)
  const [analysisText, reglasResult] = await Promise.all([
    (promptLlamadas || promptVentas)
      ? generateLlamadaAnalysisText(
          transcript,
          promptVentas ?? null,
          promptLlamadas ?? null,
          openaiApiKey,
        ).catch((err) => {
          console.error("[Effective] Error generando análisis enriquecido:", err);
          return null;
        })
      : Promise.resolve(null),
    evaluateReglas(
      transcript,
      reglasEtiquetas,
      "call",
      promptVentas ?? null,
      openaiApiKey,
    ).catch((err) => {
      console.error("[Effective] Error evaluando reglas de etiquetas:", err);
      return { matched_tags: [], matched_rules: [] };
    }),
  ]);

  // Si hay análisis enriquecido lo usamos; si no, caemos al iadesc breve del clasificador
  const iadesc = analysisText ?? classification.iadesc ?? null;

  const reglasMatchedTags: string[] = reglasResult.matched_tags;
  // Si alguna regla tiene funnelStage, la regla explícita del cliente sobreescribe la clasificación IA
  const funnelStageFromReglas: string | null = reglasResult.matched_rules
    .find((r: { id: string; tag: string; funnelStage?: string }) => r.funnelStage)?.funnelStage ?? null;

  // Procesar reglas con accion=incrementar_metrica
  if (reglasResult.matched_rules.length > 0 && idCuenta && Array.isArray(reglasEtiquetas)) {
    type ReglaConMetrica = { id: string; metrica_id?: string; metrica_incremento?: number };
    const reglasArr = reglasEtiquetas as ReglaConMetrica[];
    const matchedIds = new Set(reglasResult.matched_rules.map((r) => r.id));
    const metricaRules = reglasArr.filter(
      (r) => matchedIds.has(r.id) && r.metrica_id
    );
    if (metricaRules.length > 0) {
      try {
        const [cuentaRow] = await drizzleDb
          .select({ metricas_manual_data: cuentas.metricas_manual_data })
          .from(cuentas)
          .where(eq(cuentas.id_cuenta, idCuenta))
          .limit(1);
        const currentData = (cuentaRow?.metricas_manual_data ?? {}) as Record<string, unknown[]>;
        const today = new Date().toISOString().slice(0, 10);
        for (const rule of metricaRules) {
          if (!rule.metrica_id) continue;
          const entries = currentData[rule.metrica_id] ?? [];
          const todayIdx = (entries as Array<{date?: string; valor?: number}>).findIndex((e) => e.date === today);
          if (todayIdx >= 0) {
            (entries as Array<{date?: string; valor?: number}>)[todayIdx].valor =
              ((entries as Array<{date?: string; valor?: number}>)[todayIdx].valor ?? 0) + (rule.metrica_incremento ?? 1);
          } else {
            (entries as Array<{date?: string; valor?: number}>).push({ date: today, valor: rule.metrica_incremento ?? 1 });
          }
          currentData[rule.metrica_id] = entries;
        }
        await drizzleDb
          .update(cuentas)
          .set({ metricas_manual_data: currentData })
          .where(eq(cuentas.id_cuenta, idCuenta));
      } catch (metricaErr) {
        console.error("[Effective] Error incrementando métrica custom:", metricaErr);
      }
    }
  }

  const tagsInternos = reglasMatchedTags;
  // Regla explícita del cliente tiene mayor prioridad que clasificación IA
  const effectiveEstado = funnelStageFromReglas ?? aiEstado;

  // Construir objeto lead_embudo_personalizado si hay embudo configurado
  const leadEmbudoData = embudoPersonalizado
    ? { estado_ia: effectiveEstado, embudo_origen: "embudo_personalizado", timestamp: now.toISOString() }
    : null;

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

  // Prioridad 3: fallback por ghl_contact_id
  if (!existing && contactId) {
    try {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select(selectCols)
            .from(llamadas)
            .where(
              and(
                eq(llamadas.ghl_contact_id, contactId),
                idCuenta ? eq(llamadas.id_cuenta, idCuenta) : undefined,
              ),
            )
            .orderBy(desc(llamadas.id_registro))
            .limit(1),
        { label: "effectivePath/selectByContactId" },
      );

      existing = rows[0] ?? null;
    } catch (err) {
      console.error(`[Effective] Error buscando registro por ghl_contact_id="${contactId}":`, err);
    }
  }

  // Prioridad 4: fallback por teléfono
  if (!existing && phone) {
    try {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select(selectCols)
            .from(llamadas)
            .where(
              and(
                eq(llamadas.phone_raw_format, phone),
                idCuenta ? eq(llamadas.id_cuenta, idCuenta) : undefined,
              ),
            )
            .orderBy(desc(llamadas.id_registro))
            .limit(1),
        { label: "effectivePath/selectByPhone" },
      );

      existing = rows[0] ?? null;
    } catch (err) {
      console.error(`[Effective] Error buscando registro por phone="${phone}":`, err);
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
              estado: effectiveEstado,
              closer_mail: closerMail,
              nombre_closer: nombreCloser,
              fecha_y_hora_de_seguimiento: now,
              intentos_contacto: (existing!.intentos_contacto ?? 0) + 1,
              ...((existing!.intentos_contacto ?? 0) === 0 && { fecha_primera_llamada: now }),
              trancription: transcript,
              iadescripcion: iadesc,
              tags_internos: tagsInternos,
              ...(leadEmbudoData && { lead_embudo_personalizado: leadEmbudoData }),
              ...(callSid && { callsid: callSid }),
              ...(idUserGhl && { id_user_ghl: idUserGhl }),
              ...(contactId && { ghl_contact_id: contactId }),
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
              estado: effectiveEstado,
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
              ghl_contact_id: contactId,
              tags_internos: tagsInternos,
              ...(leadEmbudoData && { lead_embudo_personalizado: leadEmbudoData }),
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

  // ── Transicionar cita PDTE → estado clasificado (Twilio sin Fathom) ─────────
  // Si el contacto tenía una cita agendada en PDTE, la llamada efectiva la marca
  // con el estado de la IA. Solo se toca si está en PDTE para no pisar Fathom.
  if (idCuenta) {
    try {
      const agendaWhere = contactId
        ? and(eq(agendas.ghl_contact_id, contactId), eq(agendas.id_cuenta, idCuenta), eq(agendas.categoria, "PDTE"))
        : mailLead
          ? and(sql`LOWER(${agendas.email_lead}) = LOWER(${mailLead})`, eq(agendas.id_cuenta, idCuenta), eq(agendas.categoria, "PDTE"))
          : null;

      if (agendaWhere) {
        const [existingAgenda] = await withRetry(
          () =>
            drizzleDb
              .select({ id: agendas.id_registro_agenda })
              .from(agendas)
              .where(agendaWhere)
              .orderBy(desc(agendas.fecha))
              .limit(1),
          { label: "effectivePath/findAgenda" },
        );

        if (existingAgenda) {
          await withRetry(
            () =>
              drizzleDb
                .update(agendas)
                .set({
                  categoria: effectiveEstado,
                  ...(iadesc ? { resumen_ia: iadesc } : {}),
                })
                .where(eq(agendas.id_registro_agenda, existingAgenda.id)),
            { label: "effectivePath/updateAgenda" },
          );
          console.info(
            `[Effective] Agenda ${existingAgenda.id} actualizada: PDTE → ${effectiveEstado} (id_cuenta=${idCuenta})`,
          );
        }
      }
    } catch (err) {
      console.error(`[Effective] Error actualizando agenda PDTE para id_cuenta=${idCuenta}:`, err);
    }
  }

  // Tag dinámico de clasificación + tag de llamada contestada
  const tag = mapEstadoToTag(effectiveEstado);
  const locationId = fields.locationId;
  if (contactId && tokenGhl) {
    try {
      await safeAddContactTag(contactId, tokenGhl, tag, locationId);
    } catch (err) {
      console.error(`[Effective] Error aplicando tag GHL para contactId="${contactId}":`, err);
    }

    try {
      await safeAddContactTag(contactId, tokenGhl, GHL_TAGS.contestada_llamada, locationId);
    } catch (err) {
      console.error(`[Effective] Error aplicando tag contestada_llamada en GHL:`, err);
    }

    if (tagsInternos.length > 0) {
      try {
        await safeAddContactTags(contactId, tokenGhl, tagsInternos, locationId);
      } catch (err) {
        console.error(`[Effective] Error aplicando tags de reglas en GHL:`, err);
      }
    }

    if (iadesc) {
      try {
        await addContactNote(
          contactId,
          tokenGhl,
          `📞 Llamada Telefónica — Análisis IA\n\n${iadesc}`,
        );
      } catch (err) {
        const isTokenInvalid = (err as Error & { isTokenInvalid?: boolean }).isTokenInvalid;
        if (isTokenInvalid && idCuenta) {
          console.warn(`[Effective] Token GHL inválido para cuenta=${idCuenta} — guardando nota pendiente`);
          await markTokenInvalid(idCuenta);
          await savePendingNote(idCuenta, contactId, `📞 Llamada Telefónica — Análisis IA\n\n${iadesc}`, String(err));
        } else {
          console.error(`[Effective] Error agregando nota IA en GHL:`, err);
        }
      }
    }

    if (transcript) {
      try {
        await addContactNote(
          contactId,
          tokenGhl,
          `📞 Llamada Telefónica — Transcripción\n\n${transcript}`,
        );
      } catch (err) {
        const isTokenInvalid = (err as Error & { isTokenInvalid?: boolean }).isTokenInvalid;
        if (isTokenInvalid && idCuenta) {
          await savePendingNote(idCuenta, contactId, `📞 Llamada Telefónica — Transcripción\n\n${transcript}`, String(err));
        } else {
          console.error(`[Effective] Error agregando nota transcripción en GHL:`, err);
        }
      }
    }
  } else {
    if (!contactId) console.warn(`[Effective] Sin contact_id; no se puede taggear/notar en GHL`);
    if (!tokenGhl) console.warn(`[Effective] Sin token_ghl; no se puede taggear/notar en GHL`);
  }

  // ── Actualizar pipeline GHL si la regla tiene funnelStage configurado ────────
  if (funnelStageFromReglas && contactId && tokenGhl && fields.locationId) {
    const stageMap = parseFunnelStageMap(embudoPersonalizado);
    const stageId = stageMap[funnelStageFromReglas];
    if (stageId) {
      try {
        const oppId = await searchOpportunityByContact(contactId, fields.locationId, tokenGhl);
        if (oppId) {
          await updateOpportunityStage(oppId, stageId, tokenGhl);
          console.info(
            `[Effective] Opportunity ${oppId} movida a stage "${funnelStageFromReglas}" (stageId=${stageId}) para contact=${contactId}`,
          );
        } else {
          console.info(`[Effective] Sin opportunity para contact=${contactId}, se omite stage update`);
        }
      } catch (err) {
        console.error(`[Effective] Error actualizando pipeline GHL para contact=${contactId}:`, err);
      }
    }
  }

  const stlForLog = existing
    ? calcSpeedToLead(existing.estado, existing.fecha_evento, now)
    : "0";

  await insertLogEntry({
    idRegistro,
    idCuenta,
    fields,
    tipoEvento: `efectiva_${effectiveEstado}`,
    estadoResultado: effectiveEstado,
    callSid,
    transcript,
    iadesc,
    speedToLead: stlForLog,
    tagsInternos,
    leadEmbudoPersonalizado: leadEmbudoData,
  });

  return {
    success: true,
    data: {
      id_registro: idRegistro,
      action: existing && estadoActivo ? "updated" : "created",
      path: "effective",
      estado: effectiveEstado,
      buzon: false,
    },
  };
}

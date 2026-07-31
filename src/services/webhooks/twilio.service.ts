import { and, desc, eq, gte, inArray, isNull, not, or, sql } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { llamadas, logLlamadas, eventosHuerfanos, cuentas } from "../../db/schema.js";
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
  TWILIO_MACHINE_ANSWERED_BY,
} from "../twilio-api.service.js";
import {
  transcribeAudio,
  classifyCall,
  applyAnsweredCallGuard,
  mapEstadoToTag,
  resolveWebhookCategoria,
  type CallClassification,
} from "../ai/call-classification.service.js";
import { generateLlamadaAnalysisText, diarizarTranscripcion, extractLlamadaObjections } from "../ai/call-analysis.service.js";
import type { ObjecionItem } from "../ai/call-analysis.service.js";
import { evaluateReglas, type DynamicValueContext } from "../ai/reglas-evaluator.service.js";
import { applyReglasMetricActions, collectFunnelStages, collectCategoria } from "../ai/reglas-actions.service.js";
import type { ReglasEvalResult, MatchedRule } from "../ai/reglas-evaluator.service.js";
import { withRetry } from "../../utils/retry.utils.js";
import { markTokenInvalid, savePendingNote, savePendingTag } from "../ghl-token-guard.service.js";
import { writebackOpportunityFields } from "../ghl-opportunity-writeback.service.js";
import { extractCitaTarea, type CitaTareaExtraction } from "../ai/cita-tarea-extraction.service.js";
import { extractCallSummary, type CallSummary } from "../ai/call-summary.service.js";
import { updateContactCustomFields, createLocationTag, createContactTask, contactHasTag, getContactAppointmentInfo } from "../ghl-api.service.js";
import { applyMergeRules } from "../ai/closer-dedup.service.js";
import { enrichWithGemini, resolveGeminiKey } from "../ai/gemini-enrichment.service.js";
import { ubicacionPorTelefono } from "../../utils/lada.utils.js";
import { parseConfigLlamadas, countWords, filterEmbudoForCalls } from "../data/config-llamadas.utils.js";
import type { TwilioEventBody } from "../../schemas/webhooks/twilio.schema.js";
import type { ServiceResult } from "../../types/index.js";

// ─── Estados activos (solo para decidir transición de estado, NO para lookup) ─

const ESTADOS_ACTIVOS = ["pdte", "seguimiento", "programado", "no_contestada", "no_contestado"] as const;

// AUT-1960: Ventana para detectar webhooks fuera de orden. GHL dispara el "pdte"
// y el evento de llamada (no-answer/buzon/efectiva) casi simultáneamente en la
// misma automatización; si el evento de llamada se procesa PRIMERO, el registro
// ya quedó en estado resuelto y el pdte que llega después crearía un registro
// fantasma "pendiente por llamar" al lado de la llamada ya hecha. 10 min cubre el
// retraso/reintento de entrega de webhooks sin colisionar con un ciclo real nuevo
// (que se re-encola horas/días después).
const PDTE_DEDUP_WINDOW_MS = 10 * 60 * 1000;

// Estados terminales: leads cerrados que NO deben re-abrirse con nuevas llamadas
const ESTADOS_TERMINALES = ["venta", "ganado", "ganada", "perdido", "perdida", "cerrado", "cerrada"] as const;

// Ventana temporal para re-agregación: no matchear leads más antiguos que esto
const REAGREGACION_WINDOW_DAYS = 30;

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
  geminiEnriquecimiento?: object | null;
  duracionSegundos?: number | null;
  ubicacionAprox?: string | null;
  iaObjeciones?: ObjecionItem[] | null;
  resumenLlamada?: CallSummary | null;
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
          ...(entry.geminiEnriquecimiento && { gemini_enriquecimiento: entry.geminiEnriquecimiento }),
          ...(entry.duracionSegundos != null && { duracion_segundos: entry.duracionSegundos }),
          ...(entry.ubicacionAprox && { ubicacion_aprox: entry.ubicacionAprox }),
          ...(entry.iaObjeciones && { ia_objeciones: entry.iaObjeciones }),
          ...(entry.resumenLlamada && { resumen_llamada: entry.resumenLlamada }),
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
  // AUT-1863: categoría enviada por el webhook (autoritativa si presente)
  const categoriaWebhook = cd.categoria?.trim() || null;

  return { locationId, locationIdFallback, nombreLead, mailLead, phone, creativoOrigen, closerMail, nombreCloser, contactId, idUserGhl, preTranscript, categoriaWebhook };
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
        return { idCuenta: account.id_cuenta, tokenGhl: null, isCancelled: true };
      }
      return { idCuenta: account.id_cuenta, tokenGhl: account.token_ghl ?? null, isCancelled: false };
    }
    if (locationIdFallback && locationIdFallback !== locationId) {
      const fallbackAccount = await getAccountByLocationId(locationIdFallback);
      if (fallbackAccount) {
        if (fallbackAccount.estado_cuenta === "cancelado") {
          console.info(`[${label}] Cuenta cancelada (id=${fallbackAccount.id_cuenta}) — webhook descartado silenciosamente`);
          return { idCuenta: fallbackAccount.id_cuenta, tokenGhl: null, isCancelled: true };
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
  configLlamadas: unknown;
  categoriasLlamadas: unknown;
  ghlOpportunityFieldsConfig: unknown;
  ghlNativeTaskWorkflow: boolean;
  geminiApiKey: string | null;
  geminiPremiumStatus: string | null;
  isCancelled: boolean;
}> {
  const empty = { idCuenta: null, tokenGhl: null, twilioSid: null, authTwilio: null, openaiApiKey: null, embudoPersonalizado: null, promptVentas: null, promptLlamadas: null, reglasEtiquetas: null, configLlamadas: null, categoriasLlamadas: null, ghlOpportunityFieldsConfig: null, ghlNativeTaskWorkflow: false, geminiApiKey: null, geminiPremiumStatus: null, isCancelled: false };
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
      return { ...empty, idCuenta: account.id_cuenta, isCancelled: true };
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
      configLlamadas: account.config_llamadas,
      categoriasLlamadas: account.categorias_llamadas,
      ghlOpportunityFieldsConfig: account.ghl_opportunity_fields_config,
      ghlNativeTaskWorkflow: account.ghl_native_task_workflow,
      geminiApiKey: account.gemini_api_key,
      geminiPremiumStatus: account.gemini_premium_status,
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
    fecha_primera_llamada: Date | null;
  };
  let existing: ExistingRow | null = null;

  const selectCols = {
    id_registro: llamadas.id_registro,
    intentos_contacto: llamadas.intentos_contacto,
    estado: llamadas.estado,
    fecha_evento: llamadas.fecha_evento,
    fecha_primera_llamada: llamadas.fecha_primera_llamada,
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
                or(isNull(llamadas.estado), not(inArray(llamadas.estado, [...ESTADOS_TERMINALES]))),
                gte(llamadas.fecha_evento, new Date(now.getTime() - REAGREGACION_WINDOW_DAYS * 86_400_000)),
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
                or(isNull(llamadas.estado), not(inArray(llamadas.estado, [...ESTADOS_TERMINALES]))),
                gte(llamadas.fecha_evento, new Date(now.getTime() - REAGREGACION_WINDOW_DAYS * 86_400_000)),
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
                or(isNull(llamadas.estado), not(inArray(llamadas.estado, [...ESTADOS_TERMINALES]))),
                gte(llamadas.fecha_evento, new Date(now.getTime() - REAGREGACION_WINDOW_DAYS * 86_400_000)),
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
                or(isNull(llamadas.estado), not(inArray(llamadas.estado, [...ESTADOS_TERMINALES]))),
                gte(llamadas.fecha_evento, new Date(now.getTime() - REAGREGACION_WINDOW_DAYS * 86_400_000)),
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
    const isEffective = existing.estado != null && existing.estado !== "" &&
      !(ESTADOS_ACTIVOS as readonly string[]).includes(existing.estado.toLowerCase());

    try {
      await withRetry(
        () =>
          drizzleDb
            .update(llamadas)
            .set({
              nombre_lead: nombreLead,
              estado: isEffective ? existing!.estado! : "no_contestada",
              closer_mail: closerMail,
              nombre_closer: nombreCloser,
              fecha_y_hora_de_seguimiento: now,
              intentos_contacto: (existing!.intentos_contacto ?? 0) + 1,
              // AUT-1621: sanear registros legacy con llamadas pero sin fecha_primera_llamada.
              // Se setea siempre que esté NULL (no solo en el primer intento), para que
              // no queden marcados como "sin contacto" pese a tener llamadas.
              ...(existing!.fecha_primera_llamada == null && { fecha_primera_llamada: now }),
              ...(callSid && { callsid: callSid }),
              ...(!isEffective && transcript && { trancription: transcript }),
              ...(!isEffective && iadesc && { iadescripcion: iadesc }),
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
      id_cuenta: idCuenta,
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
  if (isCancelled) return { success: true, data: { id_cuenta: idCuenta, cancelled: true } };

  if (!fields.mailLead && !fields.contactId && !fields.idUserGhl && !fields.phone) {
    return saveOrphanEvent(body, idCuenta, "Twilio");
  }

  // Normalizar closer con merge rules (AUT-273) — graceful: nunca bloquea ingesta
  if (idCuenta) {
    try {
      const norm = await applyMergeRules(idCuenta, fields.closerMail, fields.nombreCloser);
      fields.closerMail = norm.email ?? fields.closerMail;
      fields.nombreCloser = norm.nombre ?? fields.nombreCloser;
    } catch (err) {
      console.error("[Twilio] Error aplicando merge rules de closer:", err);
    }
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
      return { success: true, data: { id_registro: existingPdte.id_registro, id_cuenta: idCuenta, action: "already_exists" } };
    }

    // AUT-1960: dedup de webhooks fuera de orden. El check anterior solo mira estado="pdte";
    // si el evento de llamada llegó primero, el registro ya está en un estado resuelto
    // (no_contestada, seguimiento, calificada…) y no lo encuentra. Buscamos aquí un registro
    // RECIENTE (< ventana) del mismo lead en CUALQUIER estado: si existe, el pdte pertenece al
    // mismo ciclo y no debe duplicarse — solo se registra el evento en el log y se enriquece el
    // registro existente con el closer si le faltaba.
    const recentCols = {
      id_registro: llamadas.id_registro,
      closer_mail: llamadas.closer_mail,
      nombre_closer: llamadas.nombre_closer,
      id_user_ghl: llamadas.id_user_ghl,
    };
    const windowStart = new Date(Date.now() - PDTE_DEDUP_WINDOW_MS);
    const recencyCond = gte(llamadas.fecha_evento, windowStart);
    let recentSibling: { id_registro: number; closer_mail: string | null; nombre_closer: string | null; id_user_ghl: string | null } | null = null;

    if (fields.mailLead) {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select(recentCols)
            .from(llamadas)
            .where(and(sql`LOWER(${llamadas.mail_lead}) = LOWER(${fields.mailLead!})`, accountCond, recencyCond))
            .orderBy(desc(llamadas.fecha_evento))
            .limit(1),
        { label: "Twilio/Pending/recentByEmail" },
      );
      recentSibling = rows[0] ?? null;
    }
    if (!recentSibling && fields.phone) {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select(recentCols)
            .from(llamadas)
            .where(and(eq(llamadas.phone_raw_format, fields.phone!), accountCond, recencyCond))
            .orderBy(desc(llamadas.fecha_evento))
            .limit(1),
        { label: "Twilio/Pending/recentByPhone" },
      );
      recentSibling = rows[0] ?? null;
    }
    if (!recentSibling && fields.contactId) {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select(recentCols)
            .from(llamadas)
            .where(and(eq(llamadas.ghl_contact_id, fields.contactId!), accountCond, recencyCond))
            .orderBy(desc(llamadas.fecha_evento))
            .limit(1),
        { label: "Twilio/Pending/recentByContactId" },
      );
      recentSibling = rows[0] ?? null;
    }
    if (!recentSibling && fields.idUserGhl) {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select(recentCols)
            .from(llamadas)
            .where(and(eq(llamadas.id_user_ghl, fields.idUserGhl!), accountCond, recencyCond))
            .orderBy(desc(llamadas.fecha_evento))
            .limit(1),
        { label: "Twilio/Pending/recentByGhlUserId" },
      );
      recentSibling = rows[0] ?? null;
    }

    if (recentSibling) {
      console.info(
        `[Twilio] pdte fuera de orden: ya existe registro reciente id=${recentSibling.id_registro} del mismo lead; se omite el pdte duplicado (AUT-1960).`,
      );
      // Enriquecer el registro existente con datos del closer si le faltaban (el evento de
      // llamada a veces llega sin closer/id_user_ghl y el pdte sí los trae).
      const enrich = {
        ...(!recentSibling.closer_mail && fields.closerMail ? { closer_mail: fields.closerMail } : {}),
        ...(!recentSibling.nombre_closer && fields.nombreCloser ? { nombre_closer: fields.nombreCloser } : {}),
        ...(!recentSibling.id_user_ghl && fields.idUserGhl ? { id_user_ghl: fields.idUserGhl } : {}),
      };
      if (Object.keys(enrich).length > 0) {
        await withRetry(
          () => drizzleDb.update(llamadas).set(enrich).where(eq(llamadas.id_registro, recentSibling!.id_registro)),
          { label: "Twilio/Pending/enrichCloser" },
        );
      }
      await insertLogEntry({
        idRegistro: recentSibling.id_registro,
        idCuenta,
        fields,
        tipoEvento: "pdte",
        estadoResultado: "pdte",
      });
      return { success: true, data: { id_registro: recentSibling.id_registro, id_cuenta: idCuenta, action: "out_of_order_merged" } };
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

    return { success: true, data: { id_registro: idRegistro, id_cuenta: idCuenta } };
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
  if (isCancelled) return { success: true, data: { id_cuenta: idCuenta, cancelled: true } };

  if (!fields.mailLead && !fields.contactId && !fields.idUserGhl) {
    return saveOrphanEvent(body, idCuenta, "NoAnswer");
  }

  // Normalizar closer con merge rules (AUT-273) — graceful: nunca bloquea ingesta
  if (idCuenta) {
    try {
      const norm = await applyMergeRules(idCuenta, fields.closerMail, fields.nombreCloser);
      fields.closerMail = norm.email ?? fields.closerMail;
      fields.nombreCloser = norm.nombre ?? fields.nombreCloser;
    } catch (err) {
      console.error("[NoAnswer] Error aplicando merge rules de closer:", err);
    }
  }

  return followUpPath(fields, idCuenta, tokenGhl, null, null, null, "NoAnswer");
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /webhooks/twilio/effective — Llamada efectiva (Twilio + Whisper + IA)
// ═══════════════════════════════════════════════════════════════════════════════

export async function processEffectiveCall(body: TwilioEventBody): Promise<ServiceResult> {
  const fields = extractFields(body);

  const { idCuenta, tokenGhl, twilioSid, authTwilio, openaiApiKey, embudoPersonalizado, promptVentas, promptLlamadas, reglasEtiquetas, configLlamadas, categoriasLlamadas, ghlOpportunityFieldsConfig, ghlNativeTaskWorkflow, geminiApiKey, geminiPremiumStatus, isCancelled } =
    await resolveAccountFull(fields.locationId, "Effective", fields.locationIdFallback);
  if (isCancelled) return { success: true, data: { id_cuenta: idCuenta, cancelled: true } };

  if (!fields.mailLead && !fields.contactId && !fields.idUserGhl) {
    return saveOrphanEvent(body, idCuenta, "Effective");
  }

  // Normalizar closer con merge rules (AUT-273) — graceful: nunca bloquea ingesta
  if (idCuenta) {
    try {
      const norm = await applyMergeRules(idCuenta, fields.closerMail, fields.nombreCloser);
      fields.closerMail = norm.email ?? fields.closerMail;
      fields.nombreCloser = norm.nombre ?? fields.nombreCloser;
    } catch (err) {
      console.error("[Effective] Error aplicando merge rules de closer:", err);
    }
  }

  // ── Bypass Twilio: transcripción ya viene en el payload (cuentas GHL sin Twilio) ──
  if (fields.preTranscript) {
    console.log("[Effective] Transcript pre-generado recibido — saltando pipeline Twilio/Whisper");

    // AUT-1144: evaluar reglas ANTES de clasificar para resolver categoría → prompt correcto
    let preReglasResult: ReglasEvalResult = { matched_tags: [], matched_rules: [], matched_categoria: null };
    if (fields.preTranscript.trim()) {
      try {
        const dynCtxPre: DynamicValueContext = { contactId: fields.contactId, bearerToken: tokenGhl, locationId: fields.locationId };
        preReglasResult = await evaluateReglas(fields.preTranscript, reglasEtiquetas, "call", promptVentas ?? null, openaiApiKey, idCuenta, dynCtxPre);
      } catch (err) {
        console.error("[Effective/GHL] Error evaluando reglas pre-clasificación:", err);
      }
    }
    // AUT-1863: webhook category is authoritative; fall back to reglas / matched_categoria
    const categoriaGhl = resolveWebhookCategoria(fields.categoriaWebhook, categoriasLlamadas)
      ?? collectCategoria(preReglasResult.matched_rules)
      ?? preReglasResult.matched_categoria;
    if (fields.categoriaWebhook) {
      console.log(`[Effective/GHL] Categoría webhook: "${fields.categoriaWebhook}" → resolved: ${categoriaGhl ?? "no match"}`);
    }

    // AUT-1739: filter embudo stages to only those applicable to calls
    const embudoLlamadas = filterEmbudoForCalls(embudoPersonalizado);

    // AUT-1943: short-transcript guard (misma lógica que el path Twilio principal)
    const cfgLlamadasPre = parseConfigLlamadas(configLlamadas);
    const wordCountPre = countWords(fields.preTranscript);
    const minPalabrasPre = cfgLlamadasPre?.min_palabras ?? 0;
    const shortByWordsPre = minPalabrasPre > 0 && wordCountPre < minPalabrasPre;
    const shortByCharsPre = minPalabrasPre === 0 && fields.preTranscript.trim().length < 80;
    if (shortByWordsPre || shortByCharsPre) {
      console.warn(
        `[Effective/GHL] Transcripción muy corta (${wordCountPre} palabras, ${fields.preTranscript.trim().length} chars); clasificando como seguimiento sin consumir IA`,
      );
      return followUpPath(fields, idCuenta, tokenGhl, null, fields.preTranscript, "Transcripción demasiado corta para ser una conversación real.", "Effective/GHL/short-transcript");
    }

    let classification: CallClassification;
    try {
      classification = await classifyCall(fields.preTranscript, openaiApiKey, embudoLlamadas, promptVentas, promptLlamadas, idCuenta, categoriaGhl, categoriasLlamadas);
    } catch (err) {
      console.error("[Effective/GHL] Error clasificando con IA:", err);
      return followUpPath(fields, idCuenta, tokenGhl, null, fields.preTranscript, null, "Effective/GHL");
    }
    // AUT-1083: guard defensivo contra falso buzón en llamadas contestadas cortas
    classification = applyAnsweredCallGuard(classification, fields.preTranscript, "[Effective/GHL]");
    if (classification.buzon === true || classification.buzon === null) {
      return followUpPath(fields, idCuenta, tokenGhl, null, fields.preTranscript, classification.iadesc, "Effective/GHL/buzon");
    }
    return effectivePath(fields, idCuenta, tokenGhl, null, fields.preTranscript, classification, openaiApiKey, embudoPersonalizado, promptVentas, reglasEtiquetas, promptLlamadas, preReglasResult, ghlOpportunityFieldsConfig, null, ghlNativeTaskWorkflow, geminiApiKey, geminiPremiumStatus);
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
  let callDurationSeconds: number | null = null;

  try {
    const call = await getLatestCompletedCall(twilioSid, authTwilio, fields.phone);
    if (!call) {
      console.warn(`[Effective] No se encontró llamada completada para phone="${fields.phone}"`);
      return followUpPath(fields, idCuenta, tokenGhl, null, null, null, "Effective");
    }

    // ── Guardia AMD (AUT-467): si Twilio detectó máquina, no procesar como efectiva ──
    if (call.answeredBy && TWILIO_MACHINE_ANSWERED_BY.has(call.answeredBy)) {
      console.warn(
        `[Effective] AMD detectó máquina (answeredBy="${call.answeredBy}", callSid="${call.callSid}") — enrutando a followUpPath`,
      );
      return followUpPath(
        fields,
        idCuenta,
        tokenGhl,
        call.callSid,
        null,
        `Llamada a buzón de voz detectada por Twilio AMD (answeredBy=${call.answeredBy}).`,
        "Effective/AMD-machine",
      );
    }

    callSid = call.callSid;
    callDurationSeconds = call.durationSeconds;

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
      // AUT-378: Recording aún no disponible en Twilio (race condition en llamadas largas).
      // Retornar success:false para que el webhook-recovery cron reintente en 5-10 min,
      // cuando el recording ya debería estar procesado por Twilio.
      console.warn("[Effective] Recording Twilio 404 — marcando para retry automático vía webhook-recovery");
      return { success: false, error: "recording-not-ready-404" };
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
  // Default: 80 chars. Si la cuenta tiene config_llamadas.min_palabras, usar palabras.
  const cfgLlamadas = parseConfigLlamadas(configLlamadas);
  const wordCount = countWords(transcript);
  const minPalabras = cfgLlamadas?.min_palabras ?? 0;
  const shortByWords = minPalabras > 0 && wordCount < minPalabras;
  const shortByChars = minPalabras === 0 && transcript.trim().length < 80;
  if (shortByWords || shortByChars) {
    console.warn(
      `[Effective] Transcripción muy corta (${wordCount} palabras, ${transcript.trim().length} chars); clasificando como seguimiento sin consumir IA`,
    );
    return followUpPath(fields, idCuenta, tokenGhl, callSid, transcript, "Transcripción demasiado corta para ser una conversación real.", "Effective/short-transcript");
  }

  // ── Fase 3: Evaluar reglas + Clasificación IA ──────────────────────────────

  // AUT-1144: evaluar reglas ANTES de clasificar para resolver categoría → prompt correcto
  let mainReglasResult: ReglasEvalResult = { matched_tags: [], matched_rules: [], matched_categoria: null };
  if (transcript.trim()) {
    try {
      const dynCtxMain: DynamicValueContext = { contactId: fields.contactId, bearerToken: tokenGhl, locationId: fields.locationId };
      mainReglasResult = await evaluateReglas(transcript, reglasEtiquetas, "call", promptVentas ?? null, openaiApiKey, idCuenta, dynCtxMain);
    } catch (err) {
      console.error("[Effective] Error evaluando reglas pre-clasificación:", err);
    }
  }
  // AUT-1863: webhook category is authoritative; fall back to reglas / matched_categoria
  const categoriaMain = resolveWebhookCategoria(fields.categoriaWebhook, categoriasLlamadas)
    ?? collectCategoria(mainReglasResult.matched_rules)
    ?? mainReglasResult.matched_categoria;
  if (fields.categoriaWebhook) {
    console.log(`[Effective] Categoría webhook: "${fields.categoriaWebhook}" → resolved: ${categoriaMain ?? "no match"}`);
  }

  // AUT-1739: filter embudo stages to only those applicable to calls
  const embudoLlamadasMain = filterEmbudoForCalls(embudoPersonalizado);

  let classification: CallClassification;
  try {
    classification = await classifyCall(transcript, openaiApiKey, embudoLlamadasMain, promptVentas, promptLlamadas, idCuenta, categoriaMain, categoriasLlamadas);
  } catch (err) {
    console.error("[Effective] Error clasificando llamada con IA:", err);
    return followUpPath(fields, idCuenta, tokenGhl, callSid, transcript, null, "Effective");
  }

  // ── Fase 4: Routing según resultado IA ─────────────────────────────────────

  // AUT-1083: guard defensivo contra falso buzón en llamadas contestadas cortas
  classification = applyAnsweredCallGuard(classification, transcript, "[Effective]");

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
    mainReglasResult,
    ghlOpportunityFieldsConfig,
    callDurationSeconds,
    ghlNativeTaskWorkflow,
    geminiApiKey,
    geminiPremiumStatus,
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
  preComputedReglas?: ReglasEvalResult,
  ghlOpportunityFieldsConfig?: unknown,
  callDurationSeconds?: number | null,
  ghlNativeTaskWorkflow?: boolean,
  geminiApiKey?: string | null,
  geminiPremiumStatus?: string | null,
): Promise<ServiceResult> {
  const { nombreLead, mailLead, phone, creativoOrigen, closerMail, nombreCloser, contactId, idUserGhl } = fields;
  const now = new Date();
  const aiEstado = classification.estado ?? "seguimiento";

  // AUT-1144: si las reglas ya se evaluaron antes de clasificar, reutilizar;
  // si no, evaluar ahora (fallback retrocompatible)
  const [analysisText, reglasResult, objections] = await Promise.all([
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
    preComputedReglas
      ? Promise.resolve(preComputedReglas)
      : evaluateReglas(
          transcript,
          reglasEtiquetas,
          "call",
          promptVentas ?? null,
          openaiApiKey,
          idCuenta,
          { contactId, bearerToken: tokenGhl, locationId: fields.locationId },
        ).catch((err) => {
          console.error("[Effective] Error evaluando reglas de etiquetas:", err);
          return { matched_tags: [] as string[], matched_rules: [] as MatchedRule[], matched_categoria: null };
        }),
    extractLlamadaObjections(
      transcript,
      promptVentas ?? null,
      openaiApiKey,
      idCuenta,
    ).catch((err) => {
      console.error("[Effective] Error extrayendo objeciones:", err);
      return null;
    }),
  ]);

  // Si hay análisis enriquecido lo usamos; si no, caemos al iadesc breve del clasificador
  const iadesc = analysisText ?? classification.iadesc ?? null;

  const tagsInternos: string[] = reglasResult.matched_tags;
  const funnelStageFromReglas = collectFunnelStages(reglasResult.matched_rules);

  if (reglasResult.matched_rules.length > 0 && idCuenta) {
    await applyReglasMetricActions(reglasResult.matched_rules, idCuenta, "[Effective]", {
      eventTs: now,
      eventKey: callSid ? `twilio:${callSid}` : null,
    });
  }
  // Regla explícita del cliente tiene mayor prioridad que clasificación IA
  const effectiveEstado = funnelStageFromReglas ?? aiEstado;

  // ── Extracción de cita/tarea (feature-gated por cuenta) ────────────────────
  let citaTareaResult: CitaTareaExtraction | null = null;
  if (idCuenta && transcript.trim().length >= 100) {
    try {
      citaTareaResult = await extractCitaTarea(
        transcript,
        now,
        "America/Mexico_City",
        openaiApiKey,
        idCuenta,
      );
      if (citaTareaResult) {
        console.info(
          `[Effective] CitaTarea: cita=${citaTareaResult.cita.detectada} tarea=${citaTareaResult.tarea.detectada}`,
        );
      }
    } catch (err) {
      console.warn(`[Effective] CitaTarea extraction error (fail-open):`, err instanceof Error ? err.message : err);
    }
  }

  // ── Resumen estructurado de la llamada (AUT-1945) ──────────────────────────
  let callSummaryResult: CallSummary | null = null;
  if (transcript.trim().length >= 100) {
    try {
      callSummaryResult = await extractCallSummary(
        transcript,
        openaiApiKey,
        idCuenta,
      );
      if (callSummaryResult) {
        console.info(`[Effective] CallSummary: extracted OK`);
      }
    } catch (err) {
      console.warn(`[Effective] CallSummary extraction error (fail-open):`, err instanceof Error ? err.message : err);
    }
  }

  // AUT-1301: Gemini enrichment + ubicación por lada
  const tenantGeminiKey = resolveGeminiKey({ gemini_api_key: geminiApiKey ?? null, gemini_premium_status: geminiPremiumStatus ?? null });
  const geminiResult = transcript.trim().length >= 50
    ? await enrichWithGemini(transcript, "llamada", idCuenta, tenantGeminiKey).catch((err: unknown) => {
        console.error("[Effective] Error enriquecimiento Gemini:", err);
        return null;
      })
    : null;
  const ubicacionAprox = ubicacionPorTelefono(phone);

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
    fecha_primera_llamada: Date | null;
  };
  let existing: ExistingRow | null = null;

  const selectCols = {
    id_registro: llamadas.id_registro,
    intentos_contacto: llamadas.intentos_contacto,
    estado: llamadas.estado,
    fecha_evento: llamadas.fecha_evento,
    fecha_primera_llamada: llamadas.fecha_primera_llamada,
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

  // Determinar si el registro existente es re-agregable (no terminal y dentro de ventana temporal)
  const esTerminal =
    existing?.estado != null &&
    existing.estado !== "" &&
    ESTADOS_TERMINALES.some((e) => existing!.estado!.toLowerCase() === e);
  const dentroDeVentana =
    existing?.fecha_evento != null &&
    now.getTime() - existing.fecha_evento.getTime() < REAGREGACION_WINDOW_DAYS * 86_400_000;
  const esReagregable = existing && !esTerminal && dentroDeVentana;

  let idRegistro: number | null = null;

  if (existing && esReagregable) {
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
              // AUT-1621: sanear registros legacy con llamadas pero sin fecha_primera_llamada.
              // Se setea siempre que esté NULL (no solo en el primer intento), para que
              // no queden marcados como "sin contacto" pese a tener llamadas.
              ...(existing!.fecha_primera_llamada == null && { fecha_primera_llamada: now }),
              trancription: transcript,
              iadescripcion: iadesc,
              tags_internos: tagsInternos,
              ...(leadEmbudoData && { lead_embudo_personalizado: leadEmbudoData }),
              ...(callSid && { callsid: callSid }),
              ...(idUserGhl && { id_user_ghl: idUserGhl }),
              ...(contactId && { ghl_contact_id: contactId }),
              ...(stl !== null && { speed_to_lead: stl }),
              ...(geminiResult && { gemini_enriquecimiento: geminiResult }),
              ...(callDurationSeconds != null && { duracion_segundos: callDurationSeconds }),
              ...(ubicacionAprox && { ubicacion_aprox: ubicacionAprox }),
              ...(objections && { ia_objeciones: objections }),
              ...(callSummaryResult && { resumen_llamada: callSummaryResult }),
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
              ...(geminiResult && { gemini_enriquecimiento: geminiResult }),
              ...(callDurationSeconds != null && { duracion_segundos: callDurationSeconds }),
              ...(ubicacionAprox && { ubicacion_aprox: ubicacionAprox }),
              ...(objections && { ia_objeciones: objections }),
              ...(callSummaryResult && { resumen_llamada: callSummaryResult }),
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

  // AUT-838: phone calls no longer overwrite PDTE agendas — the call analysis
  // stays in registros_de_llamada; the agenda row remains untouched.

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

  // ── Write-back de resumen IA a custom fields de oportunidad (AUT-1157) ──
  if (contactId && tokenGhl && fields.locationId) {
    await writebackOpportunityFields({
      contactId,
      locationId: fields.locationId,
      tokenGhl,
      estadoFinal: effectiveEstado,
      analysisText: analysisText,
      iadesc: classification.iadesc ?? null,
      rawConfig: ghlOpportunityFieldsConfig,
      label: "[Effective]",
    });
  }

  // ── Write-back de cita/tarea a custom fields + tag en GHL ──────────────────
  if (citaTareaResult && contactId && tokenGhl) {
    const customFieldsToWrite: Array<{ key: string; field_value: string }> = [];

    if (citaTareaResult.cita.detectada && citaTareaResult.cita.fecha_hora) {
      customFieldsToWrite.push({
        key: "fecha_y_hora_de_la_cita",
        field_value: citaTareaResult.cita.fecha_hora,
      });
    }

    if (citaTareaResult.tarea.detectada) {
      if (citaTareaResult.tarea.titulo) {
        customFieldsToWrite.push({
          key: "titulo_de_la_tarea",
          field_value: citaTareaResult.tarea.titulo,
        });
      }
      if (citaTareaResult.tarea.descripcion) {
        customFieldsToWrite.push({
          key: "descripcion_de_la_tarea",
          field_value: citaTareaResult.tarea.descripcion,
        });
      }
      if (citaTareaResult.tarea.fecha_vencimiento) {
        customFieldsToWrite.push({
          key: "fecha_de_vencimiento_de_la_tarea",
          field_value: citaTareaResult.tarea.fecha_vencimiento,
        });
      }
    }

    if (customFieldsToWrite.length > 0) {
      try {
        await updateContactCustomFields(contactId, tokenGhl, customFieldsToWrite);
        console.info(`[Effective] CitaTarea: wrote ${customFieldsToWrite.length} custom fields to GHL`);
      } catch (err) {
        console.error(`[Effective] CitaTarea: error writing custom fields (best-effort):`, err);
      }
    }

    if (citaTareaResult.tarea.detectada && fields.locationId) {
      const alreadyTagged = await contactHasTag(contactId, tokenGhl, "tarea_registradaai");
      if (alreadyTagged) {
        console.info(`[Effective] CitaTarea: contacto ya tiene tag tarea_registradaai, skip tag+task (idempotencia)`);
      } else {
        try {
          await createLocationTag(fields.locationId, tokenGhl, "tarea_registradaai");
          await safeAddContactTags(contactId, tokenGhl, ["tarea_registradaai"], fields.locationId);
          console.info(`[Effective] CitaTarea: applied tag tarea_registradaai`);
        } catch (err) {
          console.error(`[Effective] CitaTarea: error applying tarea_registradaai tag (best-effort):`, err);
        }
      }

      if (ghlNativeTaskWorkflow) {
        console.info(`[Effective] [GHL native workflow] task creation skipped for cuenta ${idCuenta}`);
      } else if (!alreadyTagged) {
        try {
          const tareaTitle = citaTareaResult.tarea.titulo ?? "Tarea de seguimiento (Auto KPI)";
          const bodyParts: string[] = [];
          if (citaTareaResult.tarea.contexto_lead) bodyParts.push(`Contexto: ${citaTareaResult.tarea.contexto_lead}`);
          if (citaTareaResult.tarea.descripcion) bodyParts.push(citaTareaResult.tarea.descripcion);
          if (citaTareaResult.tarea.callback_datetime) bodyParts.push(`Callback solicitado: ${citaTareaResult.tarea.callback_datetime}`);
          const tareaBody = bodyParts.length > 0 ? bodyParts.join("\n") : undefined;
          let dueDate = citaTareaResult.tarea.callback_datetime ?? citaTareaResult.tarea.fecha_vencimiento;
          if (!dueDate) {
            const fallback = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
            dueDate = fallback.toISOString();
          }

          let assignedTo: string | undefined;
          try {
            const apptInfo = await getContactAppointmentInfo(contactId, tokenGhl, now);
            if (apptInfo?.assignedUserId) {
              assignedTo = apptInfo.assignedUserId;
            }
          } catch { /* best-effort */ }

          const taskResult = await createContactTask(contactId, tokenGhl, {
            title: tareaTitle,
            body: tareaBody,
            dueDate,
            assignedTo,
          });
          if (taskResult) {
            console.info(`[Effective] CitaTarea: created GHL task id=${taskResult.id}`);
          }
        } catch (err) {
          console.error(`[Effective] CitaTarea: error creating GHL task (best-effort):`, err instanceof Error ? err.message : err);
        }
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
    geminiEnriquecimiento: geminiResult,
    duracionSegundos: callDurationSeconds,
    ubicacionAprox: ubicacionAprox,
    iaObjeciones: objections,
    resumenLlamada: callSummaryResult,
  });

  return {
    success: true,
    data: {
      id_registro: idRegistro,
      id_cuenta: idCuenta,
      action: existing && esReagregable ? "updated" : "created",
      path: "effective",
      estado: effectiveEstado,
      buzon: false,
    },
  };
}

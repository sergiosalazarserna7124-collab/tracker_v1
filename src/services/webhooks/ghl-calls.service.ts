/**
 * ghl-calls.service.ts
 *
 * Handlers para llamadas telefónicas en cuentas con fuente_llamadas = "ghl".
 * El pipeline es más simple que Twilio: no hay recordings propios, la transcripción
 * llega ya generada en el payload (cd.transcript) o se omite.
 *
 * Endpoints:
 *   POST /webhooks/ghl/calls/pending   → nueva llamada, estado "pdte"
 *   POST /webhooks/ghl/calls/no-answer → no contestó → estado "no_contestada"
 *   POST /webhooks/ghl/calls/effective → contestó → IA → estado clasificado
 */

import { and, desc, eq, gte, inArray, isNull, not, or, sql } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { llamadas, logLlamadas, eventosHuerfanos } from "../../db/schema.js";
import {
  addContactNote,
  getAccountByLocationId,
  getAccountById,
  getAccountFullByLocationId,
  getAccountFullById,
  safeAddContactTag,
  safeAddContactTags,
  searchOpportunityByContact,
  updateOpportunityStage,
  parseFunnelStageMap,
  GHL_TAGS,
  type CuentaFullRow,
} from "../ghl-api.service.js";
import {
  classifyCall,
  mapEstadoToTag,
  resolveWebhookCategoria,
  type CallClassification,
} from "../ai/call-classification.service.js";
import { generateLlamadaAnalysisText, diarizarTranscripcion, extractLlamadaObjections } from "../ai/call-analysis.service.js";
import type { ObjecionItem } from "../ai/call-analysis.service.js";
import { evaluateReglas } from "../ai/reglas-evaluator.service.js";
import type { ReglasEvalResult, MatchedRule } from "../ai/reglas-evaluator.service.js";
import { applyReglasMetricActions, collectFunnelStages, collectCategoria } from "../ai/reglas-actions.service.js";
import { withRetry } from "../../utils/retry.utils.js";
import { applyMergeRules } from "../ai/closer-dedup.service.js";
import { parseConfigLlamadas, countWords, filterEmbudoForCalls } from "../data/config-llamadas.utils.js";
import type { GhlCallEventBody } from "../../schemas/webhooks/ghl-calls.schema.js";
import type { ServiceResult } from "../../types/index.js";
import { writebackOpportunityFields } from "../ghl-opportunity-writeback.service.js";

// Estados activos (solo para decidir transición de estado, NO para lookup)
const ESTADOS_ACTIVOS = ["pdte", "seguimiento", "programado", "no_contestada", "no_contestado"] as const;

// AUT-1960: ventana para detectar webhooks fuera de orden (pdte que llega después del evento
// de llamada de la misma automatización). 10 min cubre el retraso/reintento de entrega sin
// colisionar con un ciclo real nuevo (que se re-encola horas/días después).
const PDTE_DEDUP_WINDOW_MS = 10 * 60 * 1000;

// Estados terminales: leads cerrados que NO deben re-abrirse con nuevas llamadas
const ESTADOS_TERMINALES = ["venta", "ganado", "ganada", "perdido", "perdida", "cerrado", "cerrada"] as const;

// Ventana temporal para re-agregación: no matchear leads más antiguos que esto
const REAGREGACION_WINDOW_DAYS = 30;

// ─── Helper: calcular speed_to_lead ──────────────────────────────────────────

function calcSpeedToLead(
  estadoAnterior: string | null,
  fechaEvento: Date | null,
  now: Date,
): string | null {
  // Calcular siempre que haya una fecha de referencia, sin importar el estado anterior.
  // El estado "pdte" es el caso ideal pero no el único — leads en "seguimiento" u otros
  // estados también deben mostrar speed to lead real.
  if (!fechaEvento) return null;
  const diffMs = now.getTime() - fechaEvento.getTime();
  const minutos = Math.round(diffMs / 60_000);
  return String(Math.max(minutos, 0));
}

// ─── Extracción de campos del payload GHL calls ───────────────────────────────

function extractFields(body: GhlCallEventBody) {
  const cd = body.customData;

  const locationId =
    cd.locationid?.trim() ||
    (body as Record<string, unknown>).locationid as string | undefined ||
    (typeof body.location === "object" && body.location !== null
      ? String((body.location as Record<string, unknown>).id ?? "")
      : "") ||
    null;

  // GHL renderiza variables de template no resueltas como la cadena literal "Undefined".
  // Filtrarla para caer al siguiente fallback en lugar de guardar ese valor inútil.
  const cleanNombre = (v: string | undefined) => {
    const t = v?.trim();
    return t && t.toLowerCase() !== "undefined" ? t : undefined;
  };
  const nombreLead =
    cleanNombre(cd.nombre) || cleanNombre(body.full_name) || cleanNombre(body.first_name) || "sin nombre";

  const bodyEmail = (body as Record<string, unknown>).email as string | undefined;
  const mailLead = bodyEmail?.trim() || (cd.email?.includes("@") ? cd.email.trim() : null);

  const phone = cd.numero?.trim() || body.phone?.trim() || null;
  const creativoOrigen = cd.utm?.trim() || null;
  const closerMail = cd.closermail?.trim() || body.user?.email?.trim() || null;
  const nombreCloser =
    cd.nombrecloser?.trim() ||
    `${body.user?.firstName ?? ""} ${body.user?.lastName ?? ""}`.trim() ||
    null;

  const contactId =
    body.contact_id?.trim() ||
    (!cd.email?.includes("@") ? cd.email?.trim() : null) ||
    null;

  const idUserGhl = cd.id_customer_ghl?.trim() || null;
  const transcript = cd.transcript?.trim() || null;
  // AUT-1863: categoría enviada por el webhook (autoritativa si presente)
  const categoriaWebhook = cd.categoria?.trim() || null;

  const rawIdCuenta = (cd as Record<string, unknown>).idcuenta;
  const idCuentaFromPayload =
    typeof rawIdCuenta === "string" && rawIdCuenta.trim() !== ""
      ? parseInt(rawIdCuenta.trim(), 10)
      : typeof rawIdCuenta === "number"
        ? rawIdCuenta
        : null;

  return {
    locationId: locationId || null,
    idCuentaFromPayload: Number.isFinite(idCuentaFromPayload) ? (idCuentaFromPayload as number) : null,
    nombreLead,
    mailLead,
    phone,
    creativoOrigen,
    closerMail,
    nombreCloser,
    contactId,
    idUserGhl,
    transcript,
    categoriaWebhook,
  };
}

// ─── Lookup de cuenta (básico) ────────────────────────────────────────────────

async function resolveAccount(
  locationId: string | null,
  label: string,
  idCuentaFallback?: number | null,
): Promise<{ idCuenta: number | null; tokenGhl: string | null; isCancelled: boolean }> {
  if (locationId) {
    try {
      const account = await getAccountByLocationId(locationId);
      if (account) {
        if (account.estado_cuenta === "cancelado") {
          console.info(`[${label}] Cuenta cancelada (id=${account.id_cuenta}) — webhook descartado silenciosamente`);
          return { idCuenta: null, tokenGhl: null, isCancelled: true };
        }
        return { idCuenta: account.id_cuenta, tokenGhl: account.token_ghl, isCancelled: false };
      }
      console.warn(`[${label}] No se encontró cuenta para locationId="${locationId}"`);
    } catch (err) {
      console.error(`[${label}] Error buscando cuenta para locationId="${locationId}":`, err);
    }
  }

  if (idCuentaFallback != null) {
    console.warn(`[${label}] locationId no resolvió — usando idcuenta del payload: ${idCuentaFallback}`);
    try {
      const account = await getAccountById(idCuentaFallback);
      if (account) {
        if (account.estado_cuenta === "cancelado") {
          console.info(`[${label}] Cuenta cancelada (id=${account.id_cuenta}) — webhook descartado silenciosamente`);
          return { idCuenta: null, tokenGhl: null, isCancelled: true };
        }
        return { idCuenta: account.id_cuenta, tokenGhl: account.token_ghl, isCancelled: false };
      }
      console.warn(`[${label}] No se encontró cuenta para id_cuenta=${idCuentaFallback}`);
    } catch (err) {
      console.error(`[${label}] Error buscando cuenta por id_cuenta=${idCuentaFallback}:`, err);
    }
  }

  if (!locationId && idCuentaFallback == null) {
    console.warn(`[${label}] Payload sin locationId ni idcuenta; no se puede resolver id_cuenta`);
  }
  return { idCuenta: null, tokenGhl: null, isCancelled: false };
}

// ─── Lookup de cuenta (completo) ─────────────────────────────────────────────

async function resolveAccountFull(
  locationId: string | null,
  label: string,
  idCuentaFallback?: number | null,
): Promise<{
  idCuenta: number | null;
  tokenGhl: string | null;
  openaiApiKey: string | null;
  embudoPersonalizado: unknown;
  promptVentas: string | null;
  promptLlamadas: string | null;
  reglasEtiquetas: unknown;
  configLlamadas: unknown;
  categoriasLlamadas: unknown;
  ghlOpportunityFieldsConfig: unknown;
  isCancelled: boolean;
}> {
  const empty = {
    idCuenta: null,
    tokenGhl: null,
    openaiApiKey: null,
    embudoPersonalizado: null,
    promptVentas: null,
    promptLlamadas: null,
    reglasEtiquetas: null,
    configLlamadas: null,
    categoriasLlamadas: null,
    ghlOpportunityFieldsConfig: null,
    isCancelled: false,
  };

  function mapAccount(account: CuentaFullRow) {
    return {
      idCuenta: account.id_cuenta,
      tokenGhl: account.token_ghl,
      openaiApiKey: account.openai_api_key,
      embudoPersonalizado: account.embudo_personalizado,
      promptVentas: account.prompt_ventas,
      promptLlamadas: account.prompt_llamadas,
      reglasEtiquetas: account.reglas_etiquetas,
      configLlamadas: account.config_llamadas,
      categoriasLlamadas: account.categorias_llamadas,
      ghlOpportunityFieldsConfig: account.ghl_opportunity_fields_config,
      isCancelled: false,
    };
  }

  if (locationId) {
    try {
      const account = await getAccountFullByLocationId(locationId);
      if (account) {
        if (account.estado_cuenta === "cancelado") {
          console.info(`[${label}] Cuenta cancelada (id=${account.id_cuenta}) — webhook descartado silenciosamente`);
          return { ...empty, isCancelled: true };
        }
        return mapAccount(account);
      }
      console.warn(`[${label}] No se encontró cuenta para locationId="${locationId}"`);
    } catch (err) {
      console.error(`[${label}] Error buscando cuenta para locationId="${locationId}":`, err);
    }
  }

  if (idCuentaFallback != null) {
    console.warn(`[${label}] locationId no resolvió — usando idcuenta del payload: ${idCuentaFallback}`);
    try {
      const account = await getAccountFullById(idCuentaFallback);
      if (account) {
        if (account.estado_cuenta === "cancelado") {
          console.info(`[${label}] Cuenta cancelada (id=${account.id_cuenta}) — webhook descartado silenciosamente`);
          return { ...empty, isCancelled: true };
        }
        return mapAccount(account);
      }
      console.warn(`[${label}] No se encontró cuenta para id_cuenta=${idCuentaFallback}`);
    } catch (err) {
      console.error(`[${label}] Error buscando cuenta por id_cuenta=${idCuentaFallback}:`, err);
    }
  }

  if (!locationId && idCuentaFallback == null) {
    console.warn(`[${label}] Payload sin locationId ni idcuenta; no se puede resolver id_cuenta`);
  }
  return empty;
}

// ─── Helper: insertar evento en log_llamadas ──────────────────────────────────

interface LogEntry {
  idRegistro: number | null;
  idCuenta: number | null;
  fields: ReturnType<typeof extractFields>;
  tipoEvento: string;
  estadoResultado: string | null;
  transcript?: string | null;
  iadesc?: string | null;
  speedToLead?: string | null;
  tagsInternos?: string[] | null;
  leadEmbudoPersonalizado?: Record<string, unknown> | null;
  iaObjeciones?: ObjecionItem[] | null;
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
          transcripcion: entry.transcript ?? null,
          ia_descripcion: entry.iadesc ?? null,
          closer_mail: entry.fields.closerMail,
          nombre_closer: entry.fields.nombreCloser,
          creativo_origen: entry.fields.creativoOrigen,
          speed_to_lead: entry.speedToLead ?? null,
          tags_internos: entry.tagsInternos ?? [],
          ...(entry.leadEmbudoPersonalizado && { lead_embudo_personalizado: entry.leadEmbudoPersonalizado }),
          ...(entry.iaObjeciones && { ia_objeciones: entry.iaObjeciones }),
        }),
      { label: "GhlCalls/insertLogEntry" },
    );
  } catch (err) {
    console.error(`[GhlCalls/Log] Error insertando en log_llamadas (tipo=${entry.tipoEvento}):`, err);
  }
}

// ─── Helper: guardar evento huérfano ─────────────────────────────────────────

async function saveOrphanEvent(
  body: GhlCallEventBody,
  idCuenta: number | null,
  label: string,
): Promise<ServiceResult> {
  console.warn(`[${label}] Lead no identificable (sin email, contact_id ni id_user_ghl). Guardando como huérfano.`);
  try {
    await drizzleDb.insert(eventosHuerfanos).values({
      id_cuenta: idCuenta,
      origen: "ghl_calls",
      motivo: "Lead no identificable: sin email, sin contact_id, sin id_user_ghl",
      payload_original: body,
      estado: "pendiente",
    });
  } catch (orphanErr) {
    console.error(`[${label}] Error guardando evento huérfano:`, orphanErr);
  }
  return { success: true, data: { path: "orphan" } };
}

// ─── followUpPath: no contestó / buzón ───────────────────────────────────────

async function followUpPath(
  fields: ReturnType<typeof extractFields>,
  idCuenta: number | null,
  tokenGhl: string | null,
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
      console.error(`[${label}] Error buscando registro para mail="${mailLead}":`, err);
    }
  }

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

  // AUT-1962: prioridad 3 — fallback por ghl_contact_id
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

  // AUT-1962: prioridad 4 — fallback por teléfono (último recurso)
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

  // Tag GHL: no contestó
  if (contactId && tokenGhl) {
    try {
      await safeAddContactTag(contactId, tokenGhl, GHL_TAGS.no_contestada_llamada, fields.locationId);
    } catch (err) {
      console.error(`[${label}] Error aplicando tag GHL:`, err);
    }
    try {
      await addContactNote(contactId, tokenGhl, "Llamada no contestada");
    } catch (err) {
      console.error(`[${label}] Error agregando nota GHL:`, err);
    }
  }

  const tipoEvento = label.toLowerCase().includes("buzon") ? "buzon" : "no_contesto";

  await insertLogEntry({
    idRegistro,
    idCuenta,
    fields,
    tipoEvento,
    estadoResultado: "no_contestada",
    transcript,
    iadesc,
    speedToLead: existing ? calcSpeedToLead(existing.estado, existing.fecha_evento, now) : "0",
  });

  return {
    success: true,
    data: { id_registro: idRegistro, action: existing ? "updated" : "created", path: "followUp" },
  };
}

// ─── effectivePath: contestó, clasificado por IA ─────────────────────────────

async function effectivePath(
  fields: ReturnType<typeof extractFields>,
  idCuenta: number | null,
  tokenGhl: string | null,
  transcript: string,
  classification: CallClassification,
  openaiApiKey?: string | null,
  embudoPersonalizado?: unknown,
  promptVentas?: string | null,
  reglasEtiquetas?: unknown,
  promptLlamadas?: string | null,
  preComputedReglas?: ReglasEvalResult,
  ghlOpportunityFieldsConfig?: unknown,
): Promise<ServiceResult> {
  const { nombreLead, mailLead, phone, creativoOrigen, closerMail, nombreCloser, contactId, idUserGhl } = fields;
  const now = new Date();
  const aiEstado = classification.estado ?? "seguimiento";

  // AUT-1144: si las reglas ya se evaluaron antes de clasificar, reutilizar
  const [analysisText, reglasResult, objections] = await Promise.all([
    (promptLlamadas || promptVentas)
      ? generateLlamadaAnalysisText(
          transcript,
          promptVentas ?? null,
          promptLlamadas ?? null,
          openaiApiKey,
        ).catch((err) => {
          console.error("[GhlCalls/Effective] Error generando análisis enriquecido:", err);
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
        ).catch((err) => {
          console.error("[GhlCalls/Effective] Error evaluando reglas de etiquetas:", err);
          return { matched_tags: [] as string[], matched_rules: [] as MatchedRule[], matched_categoria: null };
        }),
    extractLlamadaObjections(
      transcript,
      promptVentas ?? null,
      openaiApiKey,
      idCuenta,
    ).catch((err) => {
      console.error("[GhlCalls/Effective] Error extrayendo objeciones:", err);
      return null;
    }),
  ]);

  // Si hay análisis enriquecido lo usamos; si no, caemos al iadesc breve del clasificador
  const iadesc = analysisText ?? classification.iadesc ?? null;

  const tagsInternos: string[] = reglasResult.matched_tags;
  const funnelStageFromReglas = collectFunnelStages(reglasResult.matched_rules);

  if (reglasResult.matched_rules.length > 0 && idCuenta) {
    await applyReglasMetricActions(reglasResult.matched_rules, idCuenta, "[GhlCalls/Effective]", {
      eventTs: now,
      // GHL payloads lack a per-call stable ID (no callSid/recordingId equivalent).
      // contactId is the best deterministic key; same contact + same day deduplicates.
      eventKey: contactId ? `ghl:${contactId}` : null,
    });
  }
  const effectiveEstado = funnelStageFromReglas ?? aiEstado;
  const leadEmbudoData = embudoPersonalizado
    ? { estado_ia: effectiveEstado, embudo_origen: "embudo_personalizado", timestamp: now.toISOString() }
    : null;

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
        { label: "GhlCalls/effectivePath/selectByMail" },
      );
      existing = rows[0] ?? null;
    } catch (err) {
      console.error(`[GhlCalls/Effective] Error buscando registro para mail="${mailLead}":`, err);
    }
  }

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
        { label: "GhlCalls/effectivePath/selectByGhlId" },
      );
      existing = rows[0] ?? null;
    } catch (err) {
      console.error(`[GhlCalls/Effective] Error buscando registro por id_user_ghl="${idUserGhl}":`, err);
    }
  }

  // AUT-1962: prioridad 3 — fallback por ghl_contact_id
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
        { label: "GhlCalls/effectivePath/selectByContactId" },
      );
      existing = rows[0] ?? null;
      if (existing) console.log(`[GhlCalls/Effective] Encontrado por ghl_contact_id="${contactId}" id_registro=${existing.id_registro}`);
    } catch (err) {
      console.error(`[GhlCalls/Effective] Error buscando registro por ghl_contact_id="${contactId}":`, err);
    }
  }

  // AUT-1962: prioridad 4 — fallback por teléfono
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
        { label: "GhlCalls/effectivePath/selectByPhone" },
      );
      existing = rows[0] ?? null;
      if (existing) console.log(`[GhlCalls/Effective] Encontrado por phone="${phone}" id_registro=${existing.id_registro}`);
    } catch (err) {
      console.error(`[GhlCalls/Effective] Error buscando registro por phone="${phone}":`, err);
    }
  }

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
              ...(idUserGhl && { id_user_ghl: idUserGhl }),
              ...(contactId && { ghl_contact_id: contactId }),
              ...(stl !== null && { speed_to_lead: stl }),
              ...(objections && { ia_objeciones: objections }),
            })
            .where(eq(llamadas.id_registro, existing!.id_registro)),
        { label: "GhlCalls/effectivePath/update" },
      );
      idRegistro = existing.id_registro;
    } catch (err) {
      console.error(`[GhlCalls/Effective] Error actualizando registro id=${existing.id_registro}:`, err);
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
              iadescripcion: iadesc,
              id_user_ghl: idUserGhl,
              ghl_contact_id: contactId,
              tags_internos: tagsInternos,
              ...(leadEmbudoData && { lead_embudo_personalizado: leadEmbudoData }),
              ...(objections && { ia_objeciones: objections }),
            })
            .returning({ id_registro: llamadas.id_registro }),
        { label: "GhlCalls/effectivePath/insert" },
      );
      idRegistro = inserted?.id_registro ?? null;
    } catch (err) {
      console.error(`[GhlCalls/Effective] Error insertando registro para mail="${mailLead}":`, err);
      return { success: false, error: "Database error while inserting call record" };
    }
  }

  // AUT-838: phone calls no longer overwrite PDTE agendas — the call analysis
  // stays in registros_de_llamada; the agenda row remains untouched.

  // Tags GHL: clasificación + contestada + reglas
  if (contactId && tokenGhl) {
    const tag = mapEstadoToTag(effectiveEstado);
    try { await safeAddContactTag(contactId, tokenGhl, tag, fields.locationId); }
    catch (err) { console.error(`[GhlCalls/Effective] Error aplicando tag clasificación:`, err); }

    try { await safeAddContactTag(contactId, tokenGhl, GHL_TAGS.contestada_llamada, fields.locationId); }
    catch (err) { console.error(`[GhlCalls/Effective] Error aplicando tag contestada_llamada:`, err); }

    if (tagsInternos.length > 0) {
      try { await safeAddContactTags(contactId, tokenGhl, tagsInternos, fields.locationId); }
      catch (err) { console.error(`[GhlCalls/Effective] Error aplicando tags de reglas:`, err); }
    }

    if (iadesc) {
      try { await addContactNote(contactId, tokenGhl, `📞 Llamada GHL — Análisis IA\n\n${iadesc}`); }
      catch (err) { console.error(`[GhlCalls/Effective] Error agregando nota IA:`, err); }
    }

    if (transcript) {
      try {
        // Diarizar si la transcripción llegó como texto plano sin speaker labels
        const diarizedTranscript = await diarizarTranscripcion(transcript, openaiApiKey, idCuenta);
        await addContactNote(contactId, tokenGhl, `📞 Llamada GHL — Transcripción\n\n${diarizedTranscript}`);
      } catch (err) {
        console.error(`[GhlCalls/Effective] Error diarizando transcript, guardando versión original:`, err);
        // Fallback: guardar transcript original sin diarizar para no perder el dato
        try {
          await addContactNote(contactId, tokenGhl, `📞 Llamada GHL — Transcripción\n\n${transcript}`);
        } catch (e2) {
          console.error(`[GhlCalls/Effective] Error agregando nota de transcripción original:`, e2);
        }
      }
    }
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
            `[GhlCalls/Effective] Opportunity ${oppId} movida a stage "${funnelStageFromReglas}" (stageId=${stageId}) para contact=${contactId}`,
          );
        } else {
          console.info(`[GhlCalls/Effective] Sin opportunity para contact=${contactId}, se omite stage update`);
        }
      } catch (err) {
        console.error(`[GhlCalls/Effective] Error actualizando pipeline GHL para contact=${contactId}:`, err);
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
      analysisText: analysisText ?? null,
      iadesc: classification.iadesc ?? null,
      rawConfig: ghlOpportunityFieldsConfig,
      label: "[GhlCalls/Effective]",
    });
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
    transcript,
    iadesc,
    speedToLead: stlForLog,
    tagsInternos,
    leadEmbudoPersonalizado: leadEmbudoData,
    iaObjeciones: objections,
  });

  return {
    success: true,
    data: {
      id_registro: idRegistro,
      action: existing && esReagregable ? "updated" : "created",
      path: "effective",
      estado: effectiveEstado,
      buzon: false,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /webhooks/ghl/calls/pending — Nueva llamada, estado "pdte"
// ═══════════════════════════════════════════════════════════════════════════════

export async function processGhlCallPending(body: GhlCallEventBody): Promise<ServiceResult> {
  const fields = extractFields(body);

  const { idCuenta, isCancelled } = await resolveAccount(fields.locationId, "GhlCalls/Pending", fields.idCuentaFromPayload);
  if (isCancelled) return { success: true };

  if (!fields.mailLead && !fields.contactId && !fields.idUserGhl) {
    return saveOrphanEvent(body, idCuenta, "GhlCalls/Pending");
  }

  // Normalizar closer con merge rules (AUT-273) — graceful: nunca bloquea ingesta
  if (idCuenta) {
    try {
      const norm = await applyMergeRules(idCuenta, fields.closerMail, fields.nombreCloser);
      fields.closerMail = norm.email ?? fields.closerMail;
      fields.nombreCloser = norm.nombre ?? fields.nombreCloser;
    } catch (err) {
      console.error("[GhlCalls/Pending] Error aplicando merge rules de closer:", err);
    }
  }

  // Idempotency: buscar en 4 niveles antes de crear un registro nuevo.
  // GHL puede enviar el mismo lead con distintos id_user_ghl (contact IDs) en webhooks
  // separados con milisegundos de diferencia, y a veces sin email ni phone.
  // Orden de prioridad: email → phone → GHL contact_id → GHL user_id
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
        { label: "GhlCalls/Pending/checkByEmail" },
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
        { label: "GhlCalls/Pending/checkByPhone" },
      );
      existingPdte = rows[0] ?? null;
    }

    // 3. Por GHL contact_id (distinto del user_id — identifica al contacto en GHL)
    if (!existingPdte && fields.contactId) {
      const rows = await withRetry(
        () =>
          drizzleDb
            .select({ id_registro: llamadas.id_registro })
            .from(llamadas)
            .where(and(eq(llamadas.ghl_contact_id, fields.contactId!), accountCond, eq(llamadas.estado, "pdte")))
            .limit(1),
        { label: "GhlCalls/Pending/checkByContactId" },
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
        { label: "GhlCalls/Pending/checkByGhlUserId" },
      );
      existingPdte = rows[0] ?? null;
    }

    if (existingPdte) {
      console.info(`[GhlCalls/Pending] Registro PDTE ya existe (id=${existingPdte.id_registro}), ignorando duplicado.`);
      return { success: true, data: { id_registro: existingPdte.id_registro, action: "already_exists" } };
    }

    // AUT-1960: dedup de webhooks fuera de orden (mismo caso que Twilio). El check anterior solo
    // mira estado="pdte"; si el evento de llamada llegó primero, el registro ya está resuelto y no
    // lo encuentra → se creaba un pdte fantasma "pendiente por llamar" al lado de la llamada hecha.
    // Buscamos un registro RECIENTE del mismo lead en cualquier estado dentro de la ventana.
    {
      const recentCols = {
        id_registro: llamadas.id_registro,
        closer_mail: llamadas.closer_mail,
        nombre_closer: llamadas.nombre_closer,
        id_user_ghl: llamadas.id_user_ghl,
      };
      const recencyCond = gte(llamadas.fecha_evento, new Date(Date.now() - PDTE_DEDUP_WINDOW_MS));
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
          { label: "GhlCalls/Pending/recentByEmail" },
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
          { label: "GhlCalls/Pending/recentByPhone" },
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
          { label: "GhlCalls/Pending/recentByContactId" },
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
          { label: "GhlCalls/Pending/recentByGhlUserId" },
        );
        recentSibling = rows[0] ?? null;
      }

      if (recentSibling) {
        console.info(
          `[GhlCalls/Pending] pdte fuera de orden: ya existe registro reciente id=${recentSibling.id_registro} del mismo lead; se omite el pdte duplicado (AUT-1960).`,
        );
        const enrich = {
          ...(!recentSibling.closer_mail && fields.closerMail ? { closer_mail: fields.closerMail } : {}),
          ...(!recentSibling.nombre_closer && fields.nombreCloser ? { nombre_closer: fields.nombreCloser } : {}),
          ...(!recentSibling.id_user_ghl && fields.idUserGhl ? { id_user_ghl: fields.idUserGhl } : {}),
        };
        if (Object.keys(enrich).length > 0) {
          await withRetry(
            () => drizzleDb.update(llamadas).set(enrich).where(eq(llamadas.id_registro, recentSibling!.id_registro)),
            { label: "GhlCalls/Pending/enrichCloser" },
          );
        }
        await insertLogEntry({
          idRegistro: recentSibling.id_registro,
          idCuenta,
          fields,
          tipoEvento: "pdte",
          estadoResultado: "pdte",
        });
        return { success: true, data: { id_registro: recentSibling.id_registro, action: "out_of_order_merged" } };
      }
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
            iadescripcion: null,
            id_user_ghl: fields.idUserGhl,
            ghl_contact_id: fields.contactId,
          })
          .returning({ id_registro: llamadas.id_registro }),
      { label: "GhlCalls/Pending/insert" },
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
    console.error("[GhlCalls/Pending] Error insertando registro:", err);
    return { success: false, error: "Database error while inserting call record" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /webhooks/ghl/calls/no-answer — No contestó
// ═══════════════════════════════════════════════════════════════════════════════

export async function processGhlCallNoAnswer(body: GhlCallEventBody): Promise<ServiceResult> {
  const fields = extractFields(body);

  const { idCuenta, tokenGhl, isCancelled } = await resolveAccount(fields.locationId, "GhlCalls/NoAnswer", fields.idCuentaFromPayload);
  if (isCancelled) return { success: true };

  if (!fields.mailLead && !fields.contactId && !fields.idUserGhl) {
    return saveOrphanEvent(body, idCuenta, "GhlCalls/NoAnswer");
  }

  // Normalizar closer con merge rules (AUT-273) — graceful: nunca bloquea ingesta
  if (idCuenta) {
    try {
      const norm = await applyMergeRules(idCuenta, fields.closerMail, fields.nombreCloser);
      fields.closerMail = norm.email ?? fields.closerMail;
      fields.nombreCloser = norm.nombre ?? fields.nombreCloser;
    } catch (err) {
      console.error("[GhlCalls/NoAnswer] Error aplicando merge rules de closer:", err);
    }
  }

  return followUpPath(fields, idCuenta, tokenGhl, null, null, "GhlCalls/NoAnswer");
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /webhooks/ghl/calls/effective — Llamada contestada → IA
// ═══════════════════════════════════════════════════════════════════════════════

export async function processGhlCallEffective(body: GhlCallEventBody): Promise<ServiceResult> {
  const fields = extractFields(body);

  const {
    idCuenta,
    tokenGhl,
    openaiApiKey,
    embudoPersonalizado,
    promptVentas,
    promptLlamadas,
    reglasEtiquetas,
    configLlamadas,
    categoriasLlamadas,
    ghlOpportunityFieldsConfig,
    isCancelled,
  } = await resolveAccountFull(fields.locationId, "GhlCalls/Effective", fields.idCuentaFromPayload);
  if (isCancelled) return { success: true };

  if (!fields.mailLead && !fields.contactId && !fields.idUserGhl) {
    return saveOrphanEvent(body, idCuenta, "GhlCalls/Effective");
  }

  // Normalizar closer con merge rules (AUT-273) — graceful: nunca bloquea ingesta
  if (idCuenta) {
    try {
      const norm = await applyMergeRules(idCuenta, fields.closerMail, fields.nombreCloser);
      fields.closerMail = norm.email ?? fields.closerMail;
      fields.nombreCloser = norm.nombre ?? fields.nombreCloser;
    } catch (err) {
      console.error("[GhlCalls/Effective] Error aplicando merge rules de closer:", err);
    }
  }

  const transcript = fields.transcript;

  // Sin transcripción: tratar como no-answer (no hay conversación que clasificar)
  const cfgLlamadas = parseConfigLlamadas(configLlamadas);
  const wordCount = transcript ? countWords(transcript) : 0;
  const minPalabras = cfgLlamadas?.min_palabras ?? 0;
  const shortByWords = transcript && minPalabras > 0 && wordCount < minPalabras;
  const shortByChars = transcript && minPalabras === 0 && transcript.trim().length < 80;
  if (!transcript || shortByWords || shortByChars) {
    console.warn(
      `[GhlCalls/Effective] Transcripción ${!transcript ? "ausente" : `muy corta (${wordCount} palabras, ${transcript.trim().length} chars)`} — procesando como seguimiento`,
    );
    return followUpPath(
      fields,
      idCuenta,
      tokenGhl,
      transcript,
      !transcript ? null : "Transcripción demasiado corta para ser una conversación real.",
      "GhlCalls/Effective/short",
    );
  }

  // AUT-1144: evaluar reglas ANTES de clasificar para resolver categoría → prompt correcto
  let ghlReglasResult: ReglasEvalResult = { matched_tags: [], matched_rules: [], matched_categoria: null };
  if (transcript.trim()) {
    try {
      ghlReglasResult = await evaluateReglas(transcript, reglasEtiquetas, "call", promptVentas ?? null, openaiApiKey, idCuenta);
    } catch (err) {
      console.error("[GhlCalls/Effective] Error evaluando reglas pre-clasificación:", err);
    }
  }
  // AUT-1863: webhook category is authoritative; fall back to reglas / matched_categoria
  const categoriaGhl = resolveWebhookCategoria(fields.categoriaWebhook, categoriasLlamadas)
    ?? collectCategoria(ghlReglasResult.matched_rules)
    ?? ghlReglasResult.matched_categoria;
  if (fields.categoriaWebhook) {
    console.log(`[GhlCalls/Effective] Categoría webhook: "${fields.categoriaWebhook}" → resolved: ${categoriaGhl ?? "no match"}`);
  }

  // AUT-1739: filter embudo stages to only those applicable to calls
  const embudoLlamadas = filterEmbudoForCalls(embudoPersonalizado);

  // Clasificar con IA
  let classification: CallClassification;
  try {
    classification = await classifyCall(
      transcript,
      openaiApiKey,
      embudoLlamadas,
      promptVentas,
      promptLlamadas,
      idCuenta,
      categoriaGhl,
      categoriasLlamadas,
    );
  } catch (err) {
    console.error("[GhlCalls/Effective] Error clasificando con IA:", err);
    return followUpPath(fields, idCuenta, tokenGhl, transcript, null, "GhlCalls/Effective/ai-error");
  }

  // Buzón detectado por IA
  if (classification.buzon === true || classification.buzon === null) {
    return followUpPath(
      fields,
      idCuenta,
      tokenGhl,
      transcript,
      classification.iadesc,
      "GhlCalls/Effective/buzon",
    );
  }

  return effectivePath(
    fields,
    idCuenta,
    tokenGhl,
    transcript,
    classification,
    openaiApiKey,
    embudoPersonalizado,
    promptVentas,
    reglasEtiquetas,
    promptLlamadas,
    ghlReglasResult,
    ghlOpportunityFieldsConfig,
  );
}

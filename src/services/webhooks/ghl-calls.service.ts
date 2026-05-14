/**
 * ghl-calls.service.ts
 *
 * Handlers para llamadas telefónicas en cuentas con fuente_llamadas = "ghl".
 * El pipeline es más simple que Twilio: no hay recordings propios, la transcripción
 * llega ya generada en el payload (cd.transcript) o se omite.
 *
 * Endpoints:
 *   POST /webhooks/ghl/calls/pending   → nueva llamada, estado "pdte"
 *   POST /webhooks/ghl/calls/no-answer → no contestó → estado "seguimiento"
 *   POST /webhooks/ghl/calls/effective → contestó → IA → estado clasificado
 */

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { llamadas, logLlamadas, eventosHuerfanos, agendas } from "../../db/schema.js";
import {
  addContactNote,
  getAccountByLocationId,
  getAccountById,
  getAccountFullByLocationId,
  getAccountFullById,
  safeAddContactTag,
  safeAddContactTags,
  GHL_TAGS,
  type CuentaFullRow,
} from "../ghl-api.service.js";
import {
  classifyCall,
  mapEstadoToTag,
  type CallClassification,
} from "../ai/call-classification.service.js";
import { generateLlamadaAnalysisText, diarizarTranscripcion } from "../ai/call-analysis.service.js";
import { evaluateReglas } from "../ai/reglas-evaluator.service.js";
import { withRetry } from "../../utils/retry.utils.js";
import type { GhlCallEventBody } from "../../schemas/webhooks/ghl-calls.schema.js";
import type { ServiceResult } from "../../types/index.js";

// ─── Estados activos para búsqueda de registro existente ─────────────────────

const ESTADOS_ACTIVOS = ["pdte", "seguimiento", "programado", "no_contestada", "no_contestado"] as const;

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

  const nombreLead =
    cd.nombre?.trim() || body.full_name?.trim() || body.first_name?.trim() || "sin nombre";

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
  };
}

// ─── Lookup de cuenta (básico) ────────────────────────────────────────────────

async function resolveAccount(
  locationId: string | null,
  label: string,
  idCuentaFallback?: number | null,
): Promise<{ idCuenta: number | null; tokenGhl: string | null }> {
  if (locationId) {
    try {
      const account = await getAccountByLocationId(locationId);
      if (account) {
        return { idCuenta: account.id_cuenta, tokenGhl: account.token_ghl };
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
        return { idCuenta: account.id_cuenta, tokenGhl: account.token_ghl };
      }
      console.warn(`[${label}] No se encontró cuenta para id_cuenta=${idCuentaFallback}`);
    } catch (err) {
      console.error(`[${label}] Error buscando cuenta por id_cuenta=${idCuentaFallback}:`, err);
    }
  }

  if (!locationId && idCuentaFallback == null) {
    console.warn(`[${label}] Payload sin locationId ni idcuenta; no se puede resolver id_cuenta`);
  }
  return { idCuenta: null, tokenGhl: null };
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
}> {
  const empty = {
    idCuenta: null,
    tokenGhl: null,
    openaiApiKey: null,
    embudoPersonalizado: null,
    promptVentas: null,
    promptLlamadas: null,
    reglasEtiquetas: null,
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
    };
  }

  if (locationId) {
    try {
      const account = await getAccountFullByLocationId(locationId);
      if (account) return mapAccount(account);
      console.warn(`[${label}] No se encontró cuenta para locationId="${locationId}"`);
    } catch (err) {
      console.error(`[${label}] Error buscando cuenta para locationId="${locationId}":`, err);
    }
  }

  if (idCuentaFallback != null) {
    console.warn(`[${label}] locationId no resolvió — usando idcuenta del payload: ${idCuentaFallback}`);
    try {
      const account = await getAccountFullById(idCuentaFallback);
      if (account) return mapAccount(account);
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
  };
  let existing: ExistingRow | null = null;

  const selectCols = {
    id_registro: llamadas.id_registro,
    intentos_contacto: llamadas.intentos_contacto,
    estado: llamadas.estado,
    fecha_evento: llamadas.fecha_evento,
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
                or(inArray(llamadas.estado, [...ESTADOS_ACTIVOS]), isNull(llamadas.estado)),
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
                or(inArray(llamadas.estado, [...ESTADOS_ACTIVOS]), isNull(llamadas.estado)),
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
    estadoResultado: "seguimiento",
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
          console.error("[GhlCalls/Effective] Error generando análisis enriquecido:", err);
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
      console.error("[GhlCalls/Effective] Error evaluando reglas de etiquetas:", err);
      return { matched_tags: [], matched_rules: [] };
    }),
  ]);

  // Si hay análisis enriquecido lo usamos; si no, caemos al iadesc breve del clasificador
  const iadesc = analysisText ?? classification.iadesc ?? null;

  const reglasMatchedTags: string[] = reglasResult.matched_tags;
  const funnelStageFromReglas: string | null =
    reglasResult.matched_rules.find(
      (r: { id: string; tag: string; funnelStage?: string }) => r.funnelStage,
    )?.funnelStage ?? null;

  const tagsInternos = reglasMatchedTags;
  const effectiveEstado = funnelStageFromReglas ?? aiEstado;
  const leadEmbudoData = embudoPersonalizado
    ? { estado_ia: effectiveEstado, embudo_origen: "embudo_personalizado", timestamp: now.toISOString() }
    : null;

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
              trancription: transcript,
              iadescripcion: iadesc,
              tags_internos: tagsInternos,
              ...(leadEmbudoData && { lead_embudo_personalizado: leadEmbudoData }),
              ...(idUserGhl && { id_user_ghl: idUserGhl }),
              ...(stl !== null && { speed_to_lead: stl }),
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
              tags_internos: tagsInternos,
              ...(leadEmbudoData && { lead_embudo_personalizado: leadEmbudoData }),
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

  // ── Transicionar cita PDTE → estado clasificado (GHL calls sin Fathom) ──────
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
          { label: "GhlCalls/effectivePath/findAgenda" },
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
            { label: "GhlCalls/effectivePath/updateAgenda" },
          );
          console.info(
            `[GhlCalls/Effective] Agenda ${existingAgenda.id} actualizada: PDTE → ${effectiveEstado} (id_cuenta=${idCuenta})`,
          );
        }
      }
    } catch (err) {
      console.error(`[GhlCalls/Effective] Error actualizando agenda PDTE para id_cuenta=${idCuenta}:`, err);
    }
  }

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

// ═══════════════════════════════════════════════════════════════════════════════
// POST /webhooks/ghl/calls/pending — Nueva llamada, estado "pdte"
// ═══════════════════════════════════════════════════════════════════════════════

export async function processGhlCallPending(body: GhlCallEventBody): Promise<ServiceResult> {
  const fields = extractFields(body);

  if (!fields.mailLead && !fields.contactId && !fields.idUserGhl) {
    const { idCuenta } = await resolveAccount(fields.locationId, "GhlCalls/Pending", fields.idCuentaFromPayload);
    return saveOrphanEvent(body, idCuenta, "GhlCalls/Pending");
  }

  const { idCuenta } = await resolveAccount(fields.locationId, "GhlCalls/Pending", fields.idCuentaFromPayload);

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

  if (!fields.mailLead && !fields.contactId && !fields.idUserGhl) {
    const { idCuenta } = await resolveAccount(fields.locationId, "GhlCalls/NoAnswer", fields.idCuentaFromPayload);
    return saveOrphanEvent(body, idCuenta, "GhlCalls/NoAnswer");
  }

  const { idCuenta, tokenGhl } = await resolveAccount(fields.locationId, "GhlCalls/NoAnswer", fields.idCuentaFromPayload);

  return followUpPath(fields, idCuenta, tokenGhl, null, null, "GhlCalls/NoAnswer");
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /webhooks/ghl/calls/effective — Llamada contestada → IA
// ═══════════════════════════════════════════════════════════════════════════════

export async function processGhlCallEffective(body: GhlCallEventBody): Promise<ServiceResult> {
  const fields = extractFields(body);

  if (!fields.mailLead && !fields.contactId && !fields.idUserGhl) {
    const { idCuenta } = await resolveAccount(fields.locationId, "GhlCalls/Effective", fields.idCuentaFromPayload);
    return saveOrphanEvent(body, idCuenta, "GhlCalls/Effective");
  }

  const {
    idCuenta,
    tokenGhl,
    openaiApiKey,
    embudoPersonalizado,
    promptVentas,
    promptLlamadas,
    reglasEtiquetas,
  } = await resolveAccountFull(fields.locationId, "GhlCalls/Effective", fields.idCuentaFromPayload);

  const transcript = fields.transcript;

  // Sin transcripción: tratar como no-answer (no hay conversación que clasificar)
  if (!transcript || transcript.trim().length < 80) {
    console.warn(
      `[GhlCalls/Effective] Transcripción ${!transcript ? "ausente" : "muy corta"} — procesando como seguimiento`,
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

  // Clasificar con IA
  let classification: CallClassification;
  try {
    classification = await classifyCall(
      transcript,
      openaiApiKey,
      embudoPersonalizado,
      promptVentas,
      promptLlamadas,
      idCuenta,
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
  );
}

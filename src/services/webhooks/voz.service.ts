import { and, desc, eq, sql } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { llamadas, logLlamadas, eventosHuerfanos } from "../../db/schema.js";
import {
  getAccountFullById,
  searchContactByEmail,
  safeAddContactTags,
  createLocationTag,
  addContactNote,
  GHL_TAGS,
  type CuentaFullRow,
} from "../ghl-api.service.js";
import { savePendingTag } from "../ghl-token-guard.service.js";
import { evaluateReglas } from "../ai/reglas-evaluator.service.js";
import { classifyCall } from "../ai/call-classification.service.js";
import { withRetry } from "../../utils/retry.utils.js";
import type { VozCallCompletedPayload } from "../../schemas/webhooks/voz.schema.js";

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface ServiceResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

// ─── Tags nuevos para Call AI ────────────────────────────────────────────────

// ─── Alias accountid string → id_cuenta numérico (§14 multi-tenant) ─────────
const ACCOUNT_ALIAS: Record<string, number> = {
  zolutium: 40,
};

const VOZ_TAG_MAP: Record<string, string> = {
  interesado: GHL_TAGS.interesado_callai,
  no_interesado: GHL_TAGS.no_interesado_callai,
  no_elegible: GHL_TAGS.no_interesado_callai,
  reagendado: GHL_TAGS.reagenda,
  no_contesto: GHL_TAGS.no_contestada_llamada,
  buzon_voz: GHL_TAGS.no_contestada_llamada,
  colgo_temprano: GHL_TAGS.no_contestada_llamada,
  agendado: GHL_TAGS.reagenda,
  confirmado: GHL_TAGS.interesado_callai,
};

function mapVozEstadoToTag(estado: string): string | null {
  return VOZ_TAG_MAP[estado] ?? null;
}

// ─── Capa defensiva: reclasificación IA para voz_callai ─────────────────────
// Solo aplica a estados sospechosos o transcripts cortos.
// Fail-open: si la IA falla/timeout, se preserva el estado original.

export const VOZ_RECLASSIFY_CHAR_THRESHOLD = Number(
  process.env.VOZ_RECLASSIFY_CHAR_THRESHOLD ?? "120",
);

// Banda baja: transcripts bajo este umbral se reclasifican determinísticamente
// a buzon_voz SIN llamar a la IA (ahorro de créditos). Datos de prod muestran
// que ningún estado real tiene transcript < 188 chars; 150 deja margen.
export const VOZ_BAND_LOW_THRESHOLD = Number(
  process.env.VOZ_BAND_LOW_THRESHOLD ?? "150",
);

const SUSPECT_ESTADOS = new Set(["no_interesado"]);

type VozEstadoValue =
  | "interesado"
  | "no_interesado"
  | "no_elegible"
  | "reagendado"
  | "no_contesto"
  | "buzon_voz"
  | "colgo_temprano"
  | "agendado"
  | "confirmado";

export function mapClassifierToVozEstado(
  buzon: boolean | null,
  iaEstado: string | null,
): VozEstadoValue {
  if (buzon === true) return "buzon_voz";
  if (buzon === null && (!iaEstado || iaEstado === "seguimiento"))
    return "no_contesto";
  switch (iaEstado) {
    case "no_interesado":
      return "no_interesado";
    case "interesado":
      return "interesado";
    case "programado":
      return "reagendado";
    case "seguimiento":
      return "no_contesto";
    default:
      return "no_contesto";
  }
}

interface ReclassifyResult {
  estadoFinal: string;
  reclassified: boolean;
  estadoOriginal: string;
  motivo: string | null;
  iaDesc: string | null;
}

export type ClassifyCallFn = typeof classifyCall;

export async function maybeReclassifyVozEstado(
  estado: string,
  transcript: string,
  cuenta: CuentaFullRow,
  label: string,
  classifier: ClassifyCallFn = classifyCall,
): Promise<ReclassifyResult> {
  const base: ReclassifyResult = {
    estadoFinal: estado,
    reclassified: false,
    estadoOriginal: estado,
    motivo: null,
    iaDesc: null,
  };

  const trimmed = transcript.trim();
  const isSuspectEstado = SUSPECT_ESTADOS.has(estado);
  const isShortTranscript =
    trimmed.length > 0 && trimmed.length < VOZ_RECLASSIFY_CHAR_THRESHOLD;

  if (!isSuspectEstado && !isShortTranscript) return base;
  if (!trimmed) return base;

  const trigger = isSuspectEstado
    ? `estado_sospechoso(${estado})`
    : `transcript_corto(${trimmed.length}<${VOZ_RECLASSIFY_CHAR_THRESHOLD})`;

  // ── Banda baja: transcript muy corto → buzon_voz determinístico, sin IA ──
  if (trimmed.length < VOZ_BAND_LOW_THRESHOLD) {
    const nuevoEstado = "buzon_voz";
    const banda = "banda_baja_determinista";
    const changed = nuevoEstado !== estado;
    console.info(
      `${label} Reclasificación ${banda}: ${estado} → ${nuevoEstado} | len=${trimmed.length} < ${VOZ_BAND_LOW_THRESHOLD} | trigger=${trigger}`,
    );
    return {
      estadoFinal: nuevoEstado,
      reclassified: changed,
      estadoOriginal: estado,
      motivo: `${trigger} → ${banda}(len=${trimmed.length}<${VOZ_BAND_LOW_THRESHOLD})`,
      iaDesc: null,
    };
  }

  // ── Banda media/alta: transcript ≥ VOZ_BAND_LOW_THRESHOLD → clasificador IA ──
  console.info(
    `${label} Reclasificación defensiva disparada: ${trigger} | banda=ia | len=${trimmed.length}`,
  );

  try {
    const result = await Promise.race([
      classifier(
        trimmed,
        cuenta.openai_api_key,
        cuenta.embudo_personalizado,
        cuenta.prompt_ventas ?? null,
        cuenta.prompt_llamadas ?? null,
        cuenta.id_cuenta,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 8_000),
      ),
    ]);

    const nuevoEstado = mapClassifierToVozEstado(result.buzon, result.estado);

    if (nuevoEstado !== estado) {
      console.info(
        `${label} Reclasificación banda_ia: ${estado} → ${nuevoEstado} (buzon=${result.buzon}, ia_estado=${result.estado}, trigger=${trigger}, len=${trimmed.length})`,
      );
      return {
        estadoFinal: nuevoEstado,
        reclassified: true,
        estadoOriginal: estado,
        motivo: `${trigger} → banda_ia(buzon=${result.buzon},estado=${result.estado})`,
        iaDesc: result.iadesc,
      };
    }

    console.info(
      `${label} IA confirma estado original: ${estado} (trigger=${trigger}, len=${trimmed.length})`,
    );
    return { ...base, motivo: `${trigger} → confirmado`, iaDesc: result.iadesc };
  } catch (err) {
    console.warn(
      `${label} Reclasificación fail-open (se preserva estado original=${estado}):`,
      err instanceof Error ? err.message : err,
    );
    return { ...base, motivo: `${trigger} → fail-open(${err instanceof Error ? err.message : "error"})` };
  }
}

// ─── Guardar evento huérfano ─────────────────────────────────────────────────

async function saveOrphanEvent(
  payload: VozCallCompletedPayload,
  idCuenta: number | null,
  motivo: string,
): Promise<void> {
  try {
    await drizzleDb.insert(eventosHuerfanos).values({
      id_cuenta: idCuenta,
      origen: "voz-callai",
      motivo,
      payload_original: payload,
      estado: "pendiente",
    });
  } catch (err) {
    console.error("[Voz] Error guardando evento huérfano:", err);
  }
}

// ─── Procesador principal ────────────────────────────────────────────────────

export async function processVozWebhook(
  body: VozCallCompletedPayload,
): Promise<ServiceResult> {
  const label = `[Voz call_id=${body.call_id}]`;

  try {
    return await processVozInternal(body, label);
  } catch (err) {
    console.error(`${label} Error no capturado:`, err);
    await saveOrphanEvent(body, null, `Excepción: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function processVozInternal(
  body: VozCallCompletedPayload,
  label: string,
): Promise<ServiceResult> {
  // ── 1. Validar y resolver cuenta ───────────────────────────────────────────
  const rawAccountStr = String(body.accountid).trim().toLowerCase();
  const aliasResolved = ACCOUNT_ALIAS[rawAccountStr];
  const rawAccountId = aliasResolved ?? Number(body.accountid);
  if (!Number.isFinite(rawAccountId) || rawAccountId <= 0) {
    console.warn(`${label} accountid no numérico o inválido: ${body.accountid}`);
    await saveOrphanEvent(body, null, `accountid inválido: ${body.accountid}`);
    return { success: true, data: { path: "orphan", reason: "invalid_accountid" } };
  }
  if (aliasResolved) {
    console.info(`${label} accountid alias "${rawAccountStr}" → ${aliasResolved}`);
  }

  const agentid = typeof body.agentid === "string" && body.agentid.trim() ? body.agentid.trim() : null;

  const cuenta = await getAccountFullById(rawAccountId);
  if (!cuenta) {
    console.warn(`${label} Cuenta ${rawAccountId} no encontrada`);
    await saveOrphanEvent(body, rawAccountId, `Cuenta ${rawAccountId} no existe`);
    return { success: true, data: { path: "orphan", reason: "account_not_found", id_cuenta: rawAccountId } };
  }

  const idCuenta = cuenta.id_cuenta;
  console.info(`${label} Procesando para cuenta=${idCuenta} (${cuenta.nombre_cuenta}) estado=${body.estado}${agentid ? ` agentid=${agentid}` : ""}`);

  // ── 2. Estados error/desconocido → huérfano directo ────────────────────────
  if (body.estado === "error" || body.estado === "desconocido") {
    await saveOrphanEvent(body, idCuenta, `Estado ${body.estado} — para triage manual`);
    return { success: true, data: { path: "orphan", reason: body.estado, id_cuenta: idCuenta } };
  }

  // ── 3. Extraer campos del payload ──────────────────────────────────────────
  const nombreLead = body.broker_name ?? null;
  const mailLead = body.client_email ?? null;
  const phone = body.phone ?? body.client_whatsapp ?? null;
  const transcript = body.transcript ?? "";
  const iadescripcion = body.short_summary ?? null;
  const callId = body.call_id;
  const estado = body.estado;
  const now = new Date();

  // contactid (v2) es el id del contacto en GHL; userid es el alias legado.
  const contactIdRaw = body.contactid ?? body.userid ?? null;
  const ghlContactIdPayload =
    contactIdRaw !== null && contactIdRaw !== "" ? String(contactIdRaw) : null;
  const idUserGhl = ghlContactIdPayload;

  // etiquetas: tags genéricos del bot, independientes del estado (p.ej.
  // "afiliado_imexico"). Se aplican al contacto además del tag de clasificación.
  const etiquetasPayload = Array.isArray(body.etiquetas)
    ? body.etiquetas.filter((t): t is string => typeof t === "string" && t.trim() !== "")
    : [];

  // ya_afiliado: respuestas textuales del prospecto ya afiliado a otra red.
  const yaAfiliado = body.ya_afiliado ?? null;

  // reagendamiento: persistir la cita (reagendado, agendado, confirmado).
  const reagendamiento = body.reagendamiento ?? null;
  let fechaSeguimiento: Date | null = null;
  if (reagendamiento?.scheduled_for) {
    const parsed = new Date(reagendamiento.scheduled_for);
    if (!Number.isNaN(parsed.getTime())) {
      fechaSeguimiento = parsed;
    }
  }

  // ── 4. Evaluar reglas de etiquetas (si hay transcript) ─────────────────────
  let reglasMatchedTags: string[] = [];
  let reglasMatchedRules: Array<{ id: string; tag: string; funnelStage?: string }> = [];

  if (transcript.trim()) {
    try {
      const reglasResult = await evaluateReglas(
        transcript,
        cuenta.reglas_etiquetas,
        "call",
        cuenta.prompt_ventas ?? null,
        cuenta.openai_api_key,
        idCuenta,
      );
      reglasMatchedTags = reglasResult.matched_tags;
      reglasMatchedRules = reglasResult.matched_rules;
    } catch (err) {
      console.error(`${label} Error evaluando reglas de etiquetas:`, err);
    }
  }

  const tagsInternos = reglasMatchedTags;

  // ── 4b. Capa defensiva: reclasificación IA si estado sospechoso o transcript corto
  const reclassify = await maybeReclassifyVozEstado(estado, transcript, cuenta, label);
  const estadoFinal = reclassify.estadoFinal;

  if (reclassify.reclassified) {
    console.info(
      `${label} Reclasificación aplicada: ${reclassify.estadoOriginal} → ${estadoFinal} | motivo=${reclassify.motivo} | len=${transcript.trim().length}`,
    );
  }

  // ── 5. Persistir en registros_de_llamada (idempotente por call_id) ─────────
  let idRegistro: number | null = null;

  const existingByCallId = await withRetry(
    () =>
      drizzleDb
        .select({ id_registro: llamadas.id_registro })
        .from(llamadas)
        .where(and(eq(llamadas.callsid, callId), eq(llamadas.id_cuenta, idCuenta)))
        .limit(1),
    { label: "Voz/selectByCallId" },
  );

  if (existingByCallId[0]) {
    await withRetry(
      () =>
        drizzleDb
          .update(llamadas)
          .set({
            nombre_lead: nombreLead,
            estado: estadoFinal,
            mail_lead: mailLead,
            phone_raw_format: phone,
            nombre_closer: "Agente de voz - Auto KPI",
            closer_mail: "voz@autokpi.net",
            trancription: transcript || null,
            iadescripcion,
            id_user_ghl: idUserGhl,
            ghl_contact_id: ghlContactIdPayload,
            fecha_y_hora_de_seguimiento: fechaSeguimiento,
            tags_internos: tagsInternos,
            agentid,
          })
          .where(eq(llamadas.id_registro, existingByCallId[0].id_registro)),
      { label: "Voz/updateByCallId" },
    );
    idRegistro = existingByCallId[0].id_registro;
    console.info(`${label} Registro actualizado (idempotencia): id_registro=${idRegistro}`);
  } else {
    const [inserted] = await withRetry(
      () =>
        drizzleDb
          .insert(llamadas)
          .values({
            fecha_evento: now,
            id_cuenta: idCuenta,
            nombre_lead: nombreLead,
            estado: estadoFinal,
            mail_lead: mailLead,
            phone_raw_format: phone,
            creativo_origen: null,
            closer_mail: "voz@autokpi.net",
            nombre_closer: "Agente de voz - Auto KPI",
            fecha_y_hora_de_seguimiento: fechaSeguimiento,
            speed_to_lead: null,
            intentos_contacto: 1,
            fecha_primera_llamada: now,
            trancription: transcript || null,
            callsid: callId,
            iadescripcion,
            id_user_ghl: idUserGhl,
            ghl_contact_id: ghlContactIdPayload,
            tags_internos: tagsInternos,
            agentid,
          })
          .returning({ id_registro: llamadas.id_registro }),
      { label: "Voz/insert" },
    );
    idRegistro = inserted?.id_registro ?? null;
    console.info(`${label} Registro insertado: id_registro=${idRegistro}`);
  }

  // ── 6. Insertar en log_llamadas (best-effort, inmutable) ───────────────────
  try {
    await withRetry(
      () =>
        drizzleDb.insert(logLlamadas).values({
          id_registro: idRegistro,
          id_cuenta: idCuenta,
          mail_lead: mailLead,
          id_user_ghl: idUserGhl,
          contact_id_ghl: ghlContactIdPayload,
          nombre_lead: nombreLead,
          phone,
          tipo_evento: "voz_callai",
          estado_resultado: estadoFinal,
          call_sid: callId,
          transcripcion: transcript || null,
          ia_descripcion: iadescripcion,
          closer_mail: "voz@autokpi.net",
          nombre_closer: "Agente de voz - Auto KPI",
          creativo_origen: null,
          speed_to_lead: null,
          tags_internos: tagsInternos,
          agentid,
        }),
      { label: "Voz/logLlamadas" },
    );
  } catch (err) {
    console.error(`${label} Error insertando en log_llamadas (best-effort):`, err);
  }

  // ── 7. Tagging + nota en GHL ───────────────────────────────────────────────
  const tokenGhl = cuenta.token_ghl;
  const locationId = cuenta.locationid;
  let tagsAplicados: string[] = [];
  let notaAplicada = false;

  if (tokenGhl && locationId) {
    // El contactid del payload ES el id del contacto en GHL: úsalo directo.
    // Solo si no viene, caer al lookup por email/teléfono (legacy/robustez).
    let ghlContactId: string | null = ghlContactIdPayload;

    if (!ghlContactId && mailLead) {
      try {
        const contact = await searchContactByEmail(locationId, mailLead, tokenGhl);
        ghlContactId = contact?.id ?? null;
      } catch (err) {
        console.warn(`${label} Error buscando contacto GHL por email:`, err);
      }
    }
    if (!ghlContactId && phone) {
      try {
        const contact = await searchContactByEmail(locationId, phone, tokenGhl);
        ghlContactId = contact?.id ?? null;
      } catch (err) {
        console.warn(`${label} Error buscando contacto GHL por teléfono:`, err);
      }
    }

    if (ghlContactId) {
      // Si resolvimos el contacto por búsqueda (no venía en el payload), persistirlo
      if (ghlContactId !== ghlContactIdPayload && idRegistro) {
        try {
          await drizzleDb
            .update(llamadas)
            .set({ ghl_contact_id: ghlContactId })
            .where(eq(llamadas.id_registro, idRegistro));
        } catch { /* best-effort */ }
      }

      const tagsToApply: string[] = [];

      // Tag de clasificación de voz
      const clasificacionTag = mapVozEstadoToTag(estadoFinal);
      if (clasificacionTag) {
        tagsToApply.push(clasificacionTag);
      }

      // Tags de reglas de etiquetas
      if (reglasMatchedTags.length > 0) {
        tagsToApply.push(...reglasMatchedTags);
      }

      // Etiquetas genéricas del bot (independientes del estado, p.ej. afiliado_imexico)
      if (etiquetasPayload.length > 0) {
        tagsToApply.push(...etiquetasPayload);
      }

      // Dedupe (un afiliado interesado no debe recibir el mismo tag dos veces)
      const tagsUnicos = [...new Set(tagsToApply)];
      tagsToApply.length = 0;
      tagsToApply.push(...tagsUnicos);

      if (tagsToApply.length > 0) {
        try {
          // Crear tags nuevos en la location si no existen
          for (const tag of tagsToApply) {
            try {
              await createLocationTag(locationId, tokenGhl, tag);
            } catch { /* best-effort */ }
          }
          await safeAddContactTags(ghlContactId, tokenGhl, tagsToApply, locationId);
          tagsAplicados = tagsToApply;
        } catch (err) {
          const isTokenInvalid = (err as Error & { isTokenInvalid?: boolean }).isTokenInvalid;
          if (isTokenInvalid) {
            for (const tag of tagsToApply) {
              await savePendingTag(idCuenta, ghlContactId, tag, "Token GHL inválido (voz)");
            }
          } else {
            console.error(`${label} Error aplicando tags GHL:`, err);
          }
        }
      }

      // Nota en GHL con resumen + reagendamiento + transcript (best-effort)
      try {
        const noteLines: string[] = [`📞 Agente de voz - Auto KPI — estado: ${estadoFinal}`];
        if (reclassify.reclassified) {
          noteLines.push(`🔄 Reclasificado por IA: ${reclassify.estadoOriginal} → ${estadoFinal} (${reclassify.motivo})`);
        }
        if (iadescripcion) noteLines.push(`Resumen: ${iadescripcion}`);
        if (etiquetasPayload.length > 0) {
          noteLines.push(`🏷️ Etiquetas: ${etiquetasPayload.join(", ")}`);
        }
        if (yaAfiliado && (yaAfiliado.con_quien || yaAfiliado.como_le_va)) {
          noteLines.push("🤝 Ya afiliado:");
          if (yaAfiliado.con_quien) noteLines.push(`  • Con quién: ${yaAfiliado.con_quien}`);
          if (yaAfiliado.como_le_va) noteLines.push(`  • Cómo le va: ${yaAfiliado.como_le_va}`);
        }
        if (reagendamiento) {
          const tz = reagendamiento.timezone ? ` (${reagendamiento.timezone})` : "";
          const when = reagendamiento.when_text ? ` — "${reagendamiento.when_text}"` : "";
          noteLines.push(`📅 Reagendado: ${reagendamiento.scheduled_for ?? "sin fecha"}${tz}${when}`);
          if (reagendamiento.notes) noteLines.push(`Notas de la cita: ${reagendamiento.notes}`);
        }
        if (transcript.trim()) noteLines.push(`\n--- Transcript ---\n${transcript}`);
        await addContactNote(ghlContactId, tokenGhl, noteLines.join("\n"));
        notaAplicada = true;
      } catch (err) {
        console.error(`${label} Error agregando nota GHL (best-effort):`, err);
      }
    } else {
      console.warn(`${label} No se encontró contacto GHL — tags/nota sin aplicar`);
    }
  } else {
    console.warn(`${label} Cuenta sin token_ghl o locationid — tags/nota no aplicados`);
  }

  return {
    success: true,
    data: {
      path: "processed",
      id_cuenta: idCuenta,
      id_registro: idRegistro,
      estado: estadoFinal,
      estado_original: reclassify.reclassified ? reclassify.estadoOriginal : undefined,
      reclassified: reclassify.reclassified,
      reclassify_motivo: reclassify.motivo,
      ghl_contact_id: ghlContactIdPayload,
      agentid,
      reagendado: reagendamiento ? true : false,
      ya_afiliado: yaAfiliado ? true : false,
      etiquetas_payload: etiquetasPayload,
      nota_aplicada: notaAplicada,
      tags_applied: tagsAplicados,
    },
  };
}

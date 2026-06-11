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
import { withRetry } from "../../utils/retry.utils.js";
import type { VozCallCompletedPayload } from "../../schemas/webhooks/voz.schema.js";

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface ServiceResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

// ─── Tags nuevos para Call AI ────────────────────────────────────────────────

const VOZ_TAG_MAP: Record<string, string> = {
  interesado: GHL_TAGS.interesado_callai,
  no_interesado: GHL_TAGS.no_interesado_callai,
  no_elegible: GHL_TAGS.no_interesado_callai,
  reagendado: GHL_TAGS.reagenda,
  no_contesto: GHL_TAGS.no_contestada_llamada,
  buzon_voz: GHL_TAGS.no_contestada_llamada,
  colgo_temprano: GHL_TAGS.no_contestada_llamada,
};

function mapVozEstadoToTag(estado: string): string | null {
  return VOZ_TAG_MAP[estado] ?? null;
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
  const rawAccountId = Number(body.accountid);
  if (!Number.isFinite(rawAccountId) || rawAccountId <= 0) {
    console.warn(`${label} accountid no numérico o inválido: ${body.accountid}`);
    await saveOrphanEvent(body, null, `accountid inválido: ${body.accountid}`);
    return { success: true, data: { path: "orphan", reason: "invalid_accountid" } };
  }

  const cuenta = await getAccountFullById(rawAccountId);
  if (!cuenta) {
    console.warn(`${label} Cuenta ${rawAccountId} no encontrada`);
    await saveOrphanEvent(body, rawAccountId, `Cuenta ${rawAccountId} no existe`);
    return { success: true, data: { path: "orphan", reason: "account_not_found", id_cuenta: rawAccountId } };
  }

  const idCuenta = cuenta.id_cuenta;
  console.info(`${label} Procesando para cuenta=${idCuenta} (${cuenta.nombre_cuenta}) estado=${body.estado}`);

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

  // reagendamiento (solo en estado="reagendado"): persistir la cita.
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
            estado,
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
            estado,
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
          estado_resultado: estado,
          call_sid: callId,
          transcripcion: transcript || null,
          ia_descripcion: iadescripcion,
          closer_mail: "voz@autokpi.net",
          nombre_closer: "Agente de voz - Auto KPI",
          creativo_origen: null,
          speed_to_lead: null,
          tags_internos: tagsInternos,
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
      const clasificacionTag = mapVozEstadoToTag(estado);
      if (clasificacionTag) {
        tagsToApply.push(clasificacionTag);
      }

      // Tags de reglas de etiquetas
      if (reglasMatchedTags.length > 0) {
        tagsToApply.push(...reglasMatchedTags);
      }

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
        const noteLines: string[] = [`📞 Agente de voz - Auto KPI — estado: ${estado}`];
        if (iadescripcion) noteLines.push(`Resumen: ${iadescripcion}`);
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
      estado,
      ghl_contact_id: ghlContactIdPayload,
      reagendado: reagendamiento ? true : false,
      nota_aplicada: notaAplicada,
      tags_applied: tagsAplicados,
    },
  };
}

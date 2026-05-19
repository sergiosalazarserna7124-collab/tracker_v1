import { and, eq } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { db as pgPool } from "../../config/database.js";
import { llamadas, logLlamadas, agendas } from "../../db/schema.js";
import { getAccountByLocationId } from "../ghl-api.service.js";
import { withRetry } from "../../utils/retry.utils.js";
import type { ReasignacionBodyPayload } from "../../schemas/webhooks/reasignacion.schema.js";
import type { ServiceResult } from "../../types/index.js";

function extractFields(body: ReasignacionBodyPayload) {
  const cd = body.customData;
  const nombreLead = (cd.nombre ?? "").trim() || (body.full_name ?? "").trim() || (body.first_name ?? "").trim();
  const telefonoLead = (cd.telefono ?? "").trim() || (body.phone ?? "").trim();
  const locationId = (cd.locationid ?? "").trim() || (body.location?.id ?? "").trim();
  return {
    idUserGhl: (cd.idusuario ?? "").trim(),
    locationId,
    locationIdFallback: (body.location?.id ?? "").trim(),
    closerMail: (cd.correocloser ?? "").trim(),
    nombreCloser: (cd.nombrecloser ?? "").trim(),
    nombreLead,
    telefonoLead,
  };
}

export async function processReasignacion(
  body: ReasignacionBodyPayload,
): Promise<ServiceResult> {
  const fields = extractFields(body);
  const label = "Reasignacion";

  if (!fields.idUserGhl) {
    return { success: false, error: "idusuario es requerido" };
  }

  // Resolver cuenta
  let idCuenta: number | null = null;
  for (const locId of [fields.locationId, fields.locationIdFallback].filter(Boolean)) {
    if (idCuenta) break;
    try {
      const account = await getAccountByLocationId(locId);
      if (account) idCuenta = account.id_cuenta;
    } catch { /* continuar */ }
  }

  const contactId = fields.idUserGhl;
  const results: Record<string, number> = {};

  // ── 1. registros_de_llamada ─────────────────────────────────────────────────
  try {
    const llamadasPayload = {
      ...(fields.closerMail && { closer_mail: fields.closerMail }),
      ...(fields.nombreCloser && { nombre_closer: fields.nombreCloser }),
      ...(fields.nombreLead && { nombre_lead: fields.nombreLead }),
      ...(fields.telefonoLead && { phone_raw_format: fields.telefonoLead }),
    };
    if (Object.keys(llamadasPayload).length === 0) {
      console.warn(`[${label}] registros_de_llamada: sin campos a actualizar, omitiendo UPDATE`);
    } else {
      const res = await withRetry(
        () =>
          drizzleDb
            .update(llamadas)
            .set(llamadasPayload)
            .where(
              and(
                eq(llamadas.id_user_ghl, contactId),
                ...(idCuenta ? [eq(llamadas.id_cuenta, idCuenta)] : []),
              ),
            ),
        { label: `${label}/llamadas` },
      );
      results.registros_de_llamada = (res as unknown as { rowCount?: number })?.rowCount ?? 0;
    }
  } catch (err) {
    console.error(`[${label}] Error actualizando registros_de_llamada:`, err);
  }

  // ── 2. log_llamadas ─────────────────────────────────────────────────────────
  try {
    const logLlamadasPayload = {
      ...(fields.closerMail && { closer_mail: fields.closerMail }),
      ...(fields.nombreCloser && { nombre_closer: fields.nombreCloser }),
    };
    if (Object.keys(logLlamadasPayload).length === 0) {
      console.warn(`[${label}] log_llamadas: sin campos a actualizar, omitiendo UPDATE`);
    } else {
      const res = await withRetry(
        () =>
          drizzleDb
            .update(logLlamadas)
            .set(logLlamadasPayload)
            .where(
              and(
                eq(logLlamadas.contact_id_ghl, contactId),
                ...(idCuenta ? [eq(logLlamadas.id_cuenta, idCuenta)] : []),
              ),
            ),
        { label: `${label}/log_llamadas` },
      );
      results.log_llamadas = (res as unknown as { rowCount?: number })?.rowCount ?? 0;
    }
  } catch (err) {
    console.error(`[${label}] Error actualizando log_llamadas:`, err);
  }

  // ── 3. resumenes_diarios_agendas ────────────────────────────────────────────
  try {
    const closerValue = fields.closerMail || fields.nombreCloser || null;
    if (closerValue) {
      const res = await withRetry(
        () =>
          drizzleDb
            .update(agendas)
            .set({ closer: closerValue })
            .where(
              and(
                eq(agendas.ghl_contact_id, contactId),
                ...(idCuenta ? [eq(agendas.id_cuenta, idCuenta)] : []),
              ),
            ),
        { label: `${label}/agendas` },
      );
      results.resumenes_diarios_agendas = (res as unknown as { rowCount?: number })?.rowCount ?? 0;
    }
  } catch (err) {
    console.error(`[${label}] Error actualizando resumenes_diarios_agendas:`, err);
  }

  // ── 4. chats_logs (notas_extra = nombre del closer asignado) ────────────────
  try {
    const closerValue = fields.nombreCloser || fields.closerMail || null;
    if (closerValue) {
      const res = await pgPool.query(
        `UPDATE chats_logs SET notas_extra = $1
         WHERE id_lead = $2 ${idCuenta ? "AND id_cuenta = $3" : ""}`,
        idCuenta ? [closerValue, contactId, idCuenta] : [closerValue, contactId],
      );
      results.chats_logs = res.rowCount ?? 0;
    }
  } catch (err) {
    console.error(`[${label}] Error actualizando chats_logs:`, err);
  }

  const total = Object.values(results).reduce((s, v) => s + v, 0);
  console.info(`[${label}] Reasignado contactId=${contactId} → closer="${fields.nombreCloser}" <${fields.closerMail}> | registros: ${JSON.stringify(results)}`);

  return {
    success: true,
    data: {
      contact_id: contactId,
      id_cuenta: idCuenta,
      closer_mail: fields.closerMail,
      nombre_closer: fields.nombreCloser,
      registros_actualizados: results,
      total_actualizados: total,
    },
  };
}

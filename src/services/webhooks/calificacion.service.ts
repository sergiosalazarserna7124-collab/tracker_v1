import { db } from "../../config/database.js";
import { getAccountByLocationId } from "../ghl-api.service.js";
import { withRetry } from "../../utils/retry.utils.js";

export type AccionCalificacion = "calificado" | "descartado";

export interface CalificacionWebhookPayload {
  contactId: string;
  accion: AccionCalificacion;
}

export interface CalificacionResult {
  id_cuenta: number;
  contactId: string;
  accion: AccionCalificacion;
  chats_updated: number;
  llamadas_updated: number;
  log_llamadas_updated: number;
}

export async function procesarCalificacionWebhook(
  locationId: string,
  payload: CalificacionWebhookPayload,
): Promise<CalificacionResult> {
  const account = await getAccountByLocationId(locationId);
  if (!account) {
    throw new Error(`Cuenta no encontrada para locationId: ${locationId}`);
  }

  const { id_cuenta } = account;
  const { contactId, accion } = payload;

  let chatsUpdated = 0;
  let llamadasUpdated = 0;
  let logLlamadasUpdated = 0;

  const chatResult = await withRetry(
    () =>
      db.query(
        `UPDATE chats_logs
         SET calificacion_manual = $3,
             excluido_metricas = CASE
               WHEN $3 = 'descartado' THEN true
               WHEN $3 = 'calificado' THEN false
               ELSE excluido_metricas
             END
         WHERE id_cuenta = $1 AND id_lead = $2`,
        [id_cuenta, contactId, accion],
      ),
    { label: "calificacion/chats" },
  );
  chatsUpdated = chatResult.rowCount ?? 0;

  const llamadaResult = await withRetry(
    () =>
      db.query(
        `UPDATE registros_de_llamada
         SET calificacion_manual = $3,
             excluido_metricas = CASE
               WHEN $3 = 'descartado' THEN true
               WHEN $3 = 'calificado' THEN false
               ELSE excluido_metricas
             END
         WHERE id_cuenta = $1 AND ghl_contact_id = $2`,
        [id_cuenta, contactId, accion],
      ),
    { label: "calificacion/llamadas" },
  );
  llamadasUpdated = llamadaResult.rowCount ?? 0;

  const logResult = await withRetry(
    () =>
      db.query(
        `UPDATE log_llamadas
         SET calificacion_manual = $3
         WHERE id_cuenta = $1 AND contact_id_ghl = $2`,
        [id_cuenta, contactId, accion],
      ),
    { label: "calificacion/log_llamadas" },
  );
  logLlamadasUpdated = logResult.rowCount ?? 0;

  console.log(
    `[calificacion webhook] cuenta=${id_cuenta} (${account.nombre_cuenta}) ` +
    `contacto=${contactId} accion=${accion} → ` +
    `chats=${chatsUpdated} llamadas=${llamadasUpdated} log_llamadas=${logLlamadasUpdated}`,
  );

  return {
    id_cuenta,
    contactId,
    accion,
    chats_updated: chatsUpdated,
    llamadas_updated: llamadasUpdated,
    log_llamadas_updated: logLlamadasUpdated,
  };
}

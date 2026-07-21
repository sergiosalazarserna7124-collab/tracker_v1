import { db } from "../../config/database.js";
import { withRetry } from "../../utils/retry.utils.js";

export interface DescartarLeadRequest {
  id_cuenta: number;
  contact_ids: string[];
  descartar: boolean;
}

export interface DescartarLeadResult {
  chats_updated: number;
  llamadas_updated: number;
}

export async function descartarLeads(
  req: DescartarLeadRequest,
): Promise<DescartarLeadResult> {
  const { id_cuenta, contact_ids, descartar } = req;

  let chatsUpdated = 0;
  let llamadasUpdated = 0;

  for (const contactId of contact_ids) {
    const calificacionManual = descartar ? "descartado" : null;

    const chatResult = await withRetry(
      () =>
        db.query(
          `UPDATE chats_logs
           SET excluido_metricas = $3,
               calificacion_manual = $4
           WHERE id_cuenta = $1 AND id_lead = $2
             AND (excluido_metricas != $3 OR calificacion_manual IS DISTINCT FROM $4)`,
          [id_cuenta, contactId, descartar, calificacionManual],
        ),
      { label: "descartarLeads/chats" },
    );
    chatsUpdated += chatResult.rowCount ?? 0;

    const llamadaResult = await withRetry(
      () =>
        db.query(
          `UPDATE registros_de_llamada
           SET excluido_metricas = $3,
               calificacion_manual = $4
           WHERE id_cuenta = $1::text AND ghl_contact_id = $2
             AND (excluido_metricas != $3 OR calificacion_manual IS DISTINCT FROM $4)`,
          [String(id_cuenta), contactId, descartar, calificacionManual],
        ),
      { label: "descartarLeads/llamadas" },
    );
    llamadasUpdated += llamadaResult.rowCount ?? 0;
  }

  console.log(
    `[descartarLeads] cuenta=${id_cuenta} contacts=${contact_ids.length} ` +
    `descartar=${descartar} → chats=${chatsUpdated} llamadas=${llamadasUpdated}`,
  );

  return { chats_updated: chatsUpdated, llamadas_updated: llamadasUpdated };
}

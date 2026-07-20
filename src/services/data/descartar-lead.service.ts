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
    const chatResult = await withRetry(
      () =>
        db.query(
          `UPDATE chats_logs
           SET excluido_metricas = $3
           WHERE id_cuenta = $1 AND id_lead = $2 AND excluido_metricas != $3`,
          [id_cuenta, contactId, descartar],
        ),
      { label: "descartarLeads/chats" },
    );
    chatsUpdated += chatResult.rowCount ?? 0;

    const llamadaResult = await withRetry(
      () =>
        db.query(
          `UPDATE registros_de_llamada
           SET excluido_metricas = $3
           WHERE id_cuenta = $1::text AND ghl_contact_id = $2 AND excluido_metricas != $3`,
          [String(id_cuenta), contactId, descartar],
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

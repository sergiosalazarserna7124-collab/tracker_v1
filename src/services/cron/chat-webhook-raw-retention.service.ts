import { db as pgPool } from "../../config/database.js";

const BATCH_SIZE = 50_000;
const MAX_BATCHES = 20;
const RETENTION_DAYS = 14;

export async function runChatWebhookRawRetention(): Promise<{
  deletedTotal: number;
  batches: number;
  remainingOld: number;
}> {
  let deletedTotal = 0;
  let batches = 0;

  for (let i = 0; i < MAX_BATCHES; i++) {
    const res = await pgPool.query(
      `DELETE FROM chat_webhook_raw
       WHERE id IN (
         SELECT id FROM chat_webhook_raw
         WHERE received_at < NOW() - INTERVAL '${RETENTION_DAYS} days'
         ORDER BY received_at ASC
         LIMIT $1
       )`,
      [BATCH_SIZE],
    );
    const deleted = res.rowCount ?? 0;
    deletedTotal += deleted;
    batches++;

    if (deleted < BATCH_SIZE) break;
  }

  const countRes = await pgPool.query(
    `SELECT COUNT(*) AS cnt FROM chat_webhook_raw
     WHERE received_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`,
  );
  const remainingOld = parseInt(countRes.rows[0].cnt, 10);

  console.log(
    `[chat-webhook-raw-retention] deleted=${deletedTotal} batches=${batches} remainingOld=${remainingOld}`,
  );

  return { deletedTotal, batches, remainingOld };
}

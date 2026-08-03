import { db } from "../../config/database.js";
import { processChatWebhook } from "../webhooks/chat.service.js";
import type { ChatWebhookBody } from "../../schemas/webhooks/chat.schema.js";

const BATCH_SIZE = 200;
const MAX_RUNTIME_MS = 600_000;

interface PendingRow {
  id: number;
  location_id: string;
  payload: ChatWebhookBody;
}

export interface ReprocessResult {
  batches: number;
  found: number;
  processed: number;
  failed: number;
  elapsed_ms: number;
  avg_row_ms: number | null;
  stopped_reason: "drained" | "time_budget";
  errors: string[];
}

export async function reprocessPendingChatWebhooks(): Promise<ReprocessResult> {
  const startTime = Date.now();
  let totalFound = 0;
  let totalProcessed = 0;
  let totalFailed = 0;
  let batchCount = 0;
  const errors: string[] = [];
  let stoppedReason: "drained" | "time_budget" = "drained";

  while (Date.now() - startTime < MAX_RUNTIME_MS) {
    const batchStart = Date.now();

    const { rows } = await db.query<PendingRow>(
      `SELECT id, location_id, payload
       FROM chat_webhook_raw
       WHERE skip_reason = 'pending_filter'
         AND processed = false
       ORDER BY received_at ASC
       LIMIT $1`,
      [BATCH_SIZE],
    );

    if (rows.length === 0) {
      break;
    }

    batchCount++;
    totalFound += rows.length;

    for (const row of rows) {
      try {
        await processChatWebhook(row.payload, row.location_id, { skipSaveRaw: true });

        await db.query(
          `UPDATE chat_webhook_raw
           SET processed = true, skip_reason = 'reprocessed'
           WHERE id = $1`,
          [row.id],
        );
        totalProcessed++;
      } catch (err) {
        totalFailed++;
        const msg = `id=${row.id} loc=${row.location_id}: ${err instanceof Error ? err.message : String(err)}`;
        if (errors.length < 20) errors.push(msg);
        console.error(`[ReprocessPending] ${msg}`);

        await db.query(
          `UPDATE chat_webhook_raw
           SET skip_reason = 'reprocess_error'
           WHERE id = $1`,
          [row.id],
        ).catch((updateErr) => {
          console.error(`[ReprocessPending] UPDATE reprocess_error falló id=${row.id}:`, updateErr);
        });
      }
    }

    const batchMs = Date.now() - batchStart;
    console.log(
      `[ReprocessPending] batch ${batchCount}: found=${rows.length} ok=${totalProcessed} fail=${totalFailed} batch_ms=${batchMs}`,
    );

    if (Date.now() - startTime >= MAX_RUNTIME_MS) {
      stoppedReason = "time_budget";
      break;
    }
  }

  const elapsedMs = Date.now() - startTime;
  const avgRowMs = totalFound > 0 ? Math.round(elapsedMs / totalFound) : null;

  console.log(
    `[ReprocessPending] done: batches=${batchCount} found=${totalFound} processed=${totalProcessed} failed=${totalFailed} elapsed_ms=${elapsedMs} avg_row_ms=${avgRowMs} stopped=${stoppedReason}`,
  );

  return {
    batches: batchCount,
    found: totalFound,
    processed: totalProcessed,
    failed: totalFailed,
    elapsed_ms: elapsedMs,
    avg_row_ms: avgRowMs,
    stopped_reason: stoppedReason,
    errors,
  };
}

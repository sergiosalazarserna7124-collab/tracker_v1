import type { FastifyRequest, FastifyReply } from "fastify";
import { env } from "../../config/env.js";
import type { CronDailyTasksPayload, CronAnalyzeChatsPayload } from "../../schemas/cron/daily-tasks.schema.js";
import { updateNoShows, analyzeChatsNightly, expirePdteRegistros, backfillPrimerMsgLeadAt } from "../../services/cron/daily-tasks.service.js";
import { db as pgPool } from "../../config/database.js";

export async function handleUpdateNoShows(
  request: FastifyRequest<{ Body: CronDailyTasksPayload }>,
  reply: FastifyReply,
) {
  const secret = request.headers["x-cron-secret"];
  if (secret !== env.CRON_SECRET) {
    return reply.status(401).send({ success: false, error: "Unauthorized" });
  }

  const { target_date, account_ids } = request.body;

  const result = await updateNoShows({ target_date, account_ids });

  return reply.send(result);
}

// Advisory lock ID for cross-instance concurrency guard on analyzeChats.
// pg_try_advisory_lock uses bigint — pick a stable arbitrary value.
const ANALYZE_CHATS_LOCK_ID = 737_001;

export async function handleAnalyzeChats(
  request: FastifyRequest<{ Body: CronAnalyzeChatsPayload }>,
  reply: FastifyReply,
) {
  const secret = request.headers["x-cron-secret"];
  if (secret !== env.CRON_SECRET) {
    return reply.status(401).send({ success: false, error: "Unauthorized" });
  }

  const client = await pgPool.connect();
  try {
    const lockResult = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [ANALYZE_CHATS_LOCK_ID],
    );
    if (!lockResult.rows[0]?.locked) {
      return reply.status(409).send({
        success: false,
        error: "análisis ya en curso (lock global)",
        status: "already_running",
      });
    }

    const { account_ids } = request.body;

    try {
      const result = await analyzeChatsNightly(account_ids);
      console.info("[handleAnalyzeChats] Finalizado:", JSON.stringify(result));
      return reply.send({ success: true, ...result });
    } catch (err) {
      console.error("[handleAnalyzeChats] Error:", err);
      return reply.status(500).send({ success: false, error: "Error interno en análisis de chats" });
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ANALYZE_CHATS_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

export async function handleExpirePdteRegistros(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const secret = request.headers["x-cron-secret"];
  if (secret !== env.CRON_SECRET) {
    return reply.status(401).send({ success: false, error: "Unauthorized" });
  }

  try {
    const result = await expirePdteRegistros();
    return reply.send(result);
  } catch (err) {
    console.error("[handleExpirePdteRegistros] Error:", err);
    return reply.status(500).send({ success: false, error: "Error interno al expirar registros pdte" });
  }
}

export async function handleBackfillPrimerMsgLeadAt(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const secret = request.headers["x-cron-secret"];
  if (secret !== env.CRON_SECRET) {
    return reply.status(401).send({ success: false, error: "Unauthorized" });
  }

  try {
    const result = await backfillPrimerMsgLeadAt();
    return reply.send(result);
  } catch (err) {
    console.error("[handleBackfillPrimerMsgLeadAt] Error:", err);
    return reply.status(500).send({ success: false, error: "Error interno al backfill primer_msg_lead_at" });
  }
}

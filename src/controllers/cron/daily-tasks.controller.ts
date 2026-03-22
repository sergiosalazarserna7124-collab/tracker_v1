import type { FastifyRequest, FastifyReply } from "fastify";
import { env } from "../../config/env.js";
import type { CronDailyTasksPayload, CronAnalyzeChatsPayload } from "../../schemas/cron/daily-tasks.schema.js";
import { updateNoShows, analyzeChatsNightly } from "../../services/cron/daily-tasks.service.js";

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

export async function handleAnalyzeChats(
  request: FastifyRequest<{ Body: CronAnalyzeChatsPayload }>,
  reply: FastifyReply,
) {
  const secret = request.headers["x-cron-secret"];
  if (secret !== env.CRON_SECRET) {
    return reply.status(401).send({ success: false, error: "Unauthorized" });
  }

  const { account_ids } = request.body;

  try {
    const result = await analyzeChatsNightly(account_ids);
    return reply.send({ success: true, ...result });
  } catch (err) {
    console.error("[handleAnalyzeChats] Error:", err);
    return reply.status(500).send({ success: false, error: "Error interno al analizar chats" });
  }
}

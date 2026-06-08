import type { FastifyRequest, FastifyReply } from "fastify";
import { env } from "../../config/env.js";
import type { CronDailyTasksPayload, CronAnalyzeChatsPayload } from "../../schemas/cron/daily-tasks.schema.js";
import { updateNoShows, analyzeChatsNightly, expirePdteRegistros, backfillPrimerMsgLeadAt } from "../../services/cron/daily-tasks.service.js";

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

let analyzeChatsRunning = false;

export async function handleAnalyzeChats(
  request: FastifyRequest<{ Body: CronAnalyzeChatsPayload }>,
  reply: FastifyReply,
) {
  const secret = request.headers["x-cron-secret"];
  if (secret !== env.CRON_SECRET) {
    return reply.status(401).send({ success: false, error: "Unauthorized" });
  }

  if (analyzeChatsRunning) {
    return reply.status(409).send({
      success: false,
      error: "análisis ya en curso",
      status: "already_running",
    });
  }

  const { account_ids } = request.body;

  analyzeChatsRunning = true;
  analyzeChatsNightly(account_ids)
    .then((result) => {
      console.info("[handleAnalyzeChats] Finalizado en background:", JSON.stringify(result));
    })
    .catch((err) => {
      console.error("[handleAnalyzeChats] Error en background:", err);
    })
    .finally(() => {
      analyzeChatsRunning = false;
    });

  return reply.status(202).send({
    success: true,
    status: "accepted",
    message: "análisis iniciado en background",
  });
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

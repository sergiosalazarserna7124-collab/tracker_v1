import type { FastifyInstance } from "fastify";
import { CronHeaders, CronDailyTasksBody, CronAnalyzeChatsBody } from "../../schemas/cron/daily-tasks.schema.js";
import { handleUpdateNoShows, handleAnalyzeChats, handleExpirePdteRegistros, handleBackfillPrimerMsgLeadAt, handleBackfillPrimerMsgAt, handleBackfillBotDelegacionAt } from "../../controllers/cron/daily-tasks.controller.js";

export async function cronDailyTasksRoute(app: FastifyInstance) {
  app.post(
    "/update-no-shows",
    {
      schema: {
        headers: CronHeaders,
        body: CronDailyTasksBody,
      },
    },
    handleUpdateNoShows,
  );

  app.post(
    "/analizar-chats",
    {
      schema: {
        headers: CronHeaders,
        body: CronAnalyzeChatsBody,
      },
    },
    handleAnalyzeChats,
  );

  app.post(
    "/expirar-pdte",
    {
      schema: {
        headers: CronHeaders,
      },
    },
    handleExpirePdteRegistros,
  );

  app.post(
    "/backfill-primer-msg-lead-at",
    {
      schema: {
        headers: CronHeaders,
      },
    },
    handleBackfillPrimerMsgLeadAt,
  );

  app.post(
    "/backfill-primer-msg-at",
    {
      schema: {
        headers: CronHeaders,
      },
    },
    handleBackfillPrimerMsgAt,
  );

  app.post(
    "/backfill-bot-delegacion-at",
    {
      schema: {
        headers: CronHeaders,
      },
    },
    handleBackfillBotDelegacionAt,
  );
}

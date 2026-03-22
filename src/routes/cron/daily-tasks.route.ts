import type { FastifyInstance } from "fastify";
import { CronHeaders, CronDailyTasksBody, CronAnalyzeChatsBody } from "../../schemas/cron/daily-tasks.schema.js";
import { handleUpdateNoShows, handleAnalyzeChats } from "../../controllers/cron/daily-tasks.controller.js";

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
}

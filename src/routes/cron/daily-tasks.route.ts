import type { FastifyInstance } from "fastify";
import { CronHeaders, CronDailyTasksBody } from "../../schemas/cron/daily-tasks.schema.js";
import { handleUpdateNoShows } from "../../controllers/cron/daily-tasks.controller.js";

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
}

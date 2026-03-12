import type { FastifyInstance } from "fastify";
import { ReasignacionWebhookBody } from "../../schemas/webhooks/reasignacion.schema.js";
import { handleReasignacion } from "../../controllers/webhooks/reasignacion.controller.js";

export async function reasignacionRoute(app: FastifyInstance) {
  app.post(
    "/reasignacion",
    {
      schema: {
        body: ReasignacionWebhookBody,
      },
    },
    handleReasignacion,
  );
}

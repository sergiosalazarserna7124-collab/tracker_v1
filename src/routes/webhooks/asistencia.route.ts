import type { FastifyInstance } from "fastify";
import { AsistenciaWebhookBody, AsistenciaParams } from "../../schemas/webhooks/asistencia.schema.js";
import { handleAsistenciaWebhook } from "../../controllers/webhooks/asistencia.controller.js";

export async function asistenciaWebhookRoute(app: FastifyInstance) {
  app.post(
    "/asistencia/:id_cuenta",
    {
      schema: {
        params: AsistenciaParams,
        body: AsistenciaWebhookBody,
      },
    },
    handleAsistenciaWebhook,
  );
}

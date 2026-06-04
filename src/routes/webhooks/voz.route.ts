import type { FastifyInstance } from "fastify";
import { VozCallCompletedBody } from "../../schemas/webhooks/voz.schema.js";
import { handleVozWebhook } from "../../controllers/webhooks/voz.controller.js";

export async function vozWebhookRoute(app: FastifyInstance) {
  app.post(
    "/voz",
    { schema: { body: VozCallCompletedBody } },
    handleVozWebhook,
  );
}

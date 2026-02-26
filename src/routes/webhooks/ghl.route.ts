import type { FastifyInstance } from "fastify";
import { GhlWebhookBody } from "../../schemas/webhooks/ghl.schema.js";
import { handleGhlWebhook } from "../../controllers/webhooks/ghl.controller.js";

export async function ghlWebhookRoute(app: FastifyInstance) {
  app.post(
    "/ghl",
    {
      schema: {
        body: GhlWebhookBody,
      },
    },
    handleGhlWebhook,
  );
}

import type { FastifyInstance } from "fastify";
import { FathomWebhookBody, FathomParams } from "../../schemas/webhooks/fathom.schema.js";
import { handleFathomWebhook } from "../../controllers/webhooks/fathom.controller.js";

export async function fathomWebhookRoute(app: FastifyInstance) {
  app.post(
    "/fathom/:id_cuenta",
    {
      bodyLimit: 10 * 1024 * 1024, // 10 MB por transcripciones largas
      schema: {
        params: FathomParams,
        body: FathomWebhookBody,
      },
    },
    handleFathomWebhook,
  );
}

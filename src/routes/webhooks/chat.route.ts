import type { FastifyInstance } from "fastify";
import { ChatWebhookBodySchema } from "../../schemas/webhooks/chat.schema.js";
import { handleChatWebhook } from "../../controllers/webhooks/chat.controller.js";

export async function chatWebhookRoute(app: FastifyInstance) {
  app.post(
    "/chat",
    {
      schema: {
        body: ChatWebhookBodySchema,
      },
    },
    handleChatWebhook,
  );
}

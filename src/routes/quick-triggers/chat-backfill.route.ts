import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import {
  ChatBackfillBody,
  type ChatBackfillBodyType,
} from "../../schemas/quick-triggers/chat-backfill.schema.js";
import { handleChatBackfill } from "../../controllers/quick-triggers/chat-backfill.controller.js";

export async function chatBackfillRoute(app: FastifyInstance) {
  app.post<{ Body: ChatBackfillBodyType }>(
    "/chat-backfill",
    {
      preHandler: [apiKeyAuthHook],
      schema: { body: ChatBackfillBody },
    },
    handleChatBackfill,
  );
}

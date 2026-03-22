import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import {
  ChatRecoveryPreviewBody,
  ChatRecoveryExecuteBody,
  type ChatRecoveryPreviewBodyType,
  type ChatRecoveryExecuteBodyType,
} from "../../schemas/quick-triggers/chat-recovery.schema.js";
import {
  handleChatRecoveryPreview,
  handleChatRecoveryExecute,
} from "../../controllers/quick-triggers/chat-recovery.controller.js";

export async function chatRecoveryRoute(app: FastifyInstance) {
  app.post<{ Body: ChatRecoveryPreviewBodyType }>(
    "/chat-recovery/preview",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        body: ChatRecoveryPreviewBody,
      },
    },
    handleChatRecoveryPreview,
  );

  app.post<{ Body: ChatRecoveryExecuteBodyType }>(
    "/chat-recovery/execute",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        body: ChatRecoveryExecuteBody,
      },
    },
    handleChatRecoveryExecute,
  );
}

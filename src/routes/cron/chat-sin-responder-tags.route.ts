import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { env } from "../../config/env.js";
import { runChatSinResponderTags } from "../../services/cron/chat-sin-responder-tags.service.js";

export async function cronChatSinResponderTagsRoute(app: FastifyInstance) {
  app.post(
    "/chat-sin-responder-tags",
    {
      schema: {
        headers: Type.Object(
          { "x-cron-secret": Type.String() },
          { additionalProperties: true },
        ),
      },
    },
    async (request, reply) => {
      const secret = request.headers["x-cron-secret"] as string | undefined;
      if (secret !== env.CRON_SECRET) {
        return reply.status(401).send({ success: false, error: "Unauthorized" });
      }

      try {
        const resultado = await runChatSinResponderTags();
        return reply.send({ success: true, ...resultado });
      } catch (err) {
        console.error("[chat-sin-responder-tags] Error en cron:", err);
        return reply.status(500).send({ success: false, error: "Error interno en chat-sin-responder-tags" });
      }
    },
  );
}

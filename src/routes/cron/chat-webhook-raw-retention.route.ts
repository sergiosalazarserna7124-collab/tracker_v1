import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import { env } from "../../config/env.js";
import { runChatWebhookRawRetention } from "../../services/cron/chat-webhook-raw-retention.service.js";

const CronHeaders = Type.Object(
  { "x-cron-secret": Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);

async function handleChatWebhookRawRetention(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const secret = request.headers["x-cron-secret"];
  if (secret !== env.CRON_SECRET) {
    return reply.status(401).send({ success: false, error: "Unauthorized" });
  }

  try {
    const result = await runChatWebhookRawRetention();
    return reply.send({ success: true, ...result });
  } catch (err) {
    console.error("[handleChatWebhookRawRetention] Error:", err);
    return reply.status(500).send({
      success: false,
      error: "Error interno en chat-webhook-raw-retention",
    });
  }
}

export async function cronChatWebhookRawRetentionRoute(app: FastifyInstance) {
  app.post(
    "/chat-webhook-raw-retention",
    {
      schema: {
        headers: CronHeaders,
      },
    },
    handleChatWebhookRawRetention,
  );
}

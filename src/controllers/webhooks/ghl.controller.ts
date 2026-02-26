import type { FastifyRequest, FastifyReply } from "fastify";
import type { GhlWebhookPayload } from "../../schemas/webhooks/ghl.schema.js";
import { processGhlWebhook } from "../../services/webhooks/ghl.service.js";
import type { WebhookResponse } from "../../types/index.js";

export async function handleGhlWebhook(
  request: FastifyRequest<{ Body: GhlWebhookPayload }>,
  reply: FastifyReply,
): Promise<WebhookResponse> {
  const result = await processGhlWebhook(request.body);

  if (!result.success) {
    return reply.status(422).send({
      success: false,
      message: result.error ?? "Failed to process GHL webhook",
    });
  }

  // Si el evento fue ignorado (categoria distinta a "pendiente")
  if (!result.data) {
    return { success: true, message: "GHL event acknowledged (no action required)" };
  }

  return {
    success: true,
    message: "GHL booking registered as PDTE",
    data: result.data,
  };
}

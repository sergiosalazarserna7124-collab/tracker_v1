import type { FastifyRequest, FastifyReply } from "fastify";
import type { GhlWebhookPayload, GhlBodyPayload } from "../../schemas/webhooks/ghl.schema.js";
import { processGhlWebhook } from "../../services/webhooks/ghl.service.js";
import { extractWebhookBody } from "../../utils/payload.utils.js";
import type { WebhookResponse } from "../../types/index.js";

export async function handleGhlWebhook(
  request: FastifyRequest<{ Body: GhlWebhookPayload }>,
  reply: FastifyReply,
): Promise<WebhookResponse> {
  const body = extractWebhookBody<GhlBodyPayload>(request.body);

  if (!body) {
    return reply.status(400).send({
      success: false,
      message: "Missing or invalid GHL event payload",
    });
  }

  const result = await processGhlWebhook(body);

  if (!result.success) {
    return reply.status(422).send({
      success: false,
      message: result.error ?? "Failed to process GHL webhook",
    });
  }

  // Si el evento fue ignorado (categoria distinta a "pendiente" / "cancelada" / "reagenda")
  if (!result.data) {
    return { success: true, message: "GHL event acknowledged (no action required)" };
  }

  return {
    success: true,
    message: "GHL booking registered as PDTE",
    data: result.data,
  };
}

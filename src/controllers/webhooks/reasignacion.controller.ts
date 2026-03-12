import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  ReasignacionWebhookPayload,
  ReasignacionBodyPayload,
} from "../../schemas/webhooks/reasignacion.schema.js";
import { processReasignacion } from "../../services/webhooks/reasignacion.service.js";
import { extractWebhookBody } from "../../utils/payload.utils.js";

export async function handleReasignacion(
  request: FastifyRequest<{ Body: ReasignacionWebhookPayload }>,
  reply: FastifyReply,
): Promise<void> {
  const eventBody = extractWebhookBody<ReasignacionBodyPayload>(request.body);

  if (!eventBody) {
    return reply.status(400).send({
      success: false,
      message: "Missing or invalid reasignacion payload",
    });
  }

  const result = await processReasignacion(eventBody);

  if (!result.success) {
    return reply.status(422).send({
      success: false,
      message: result.error ?? "Failed to process reasignacion",
    });
  }

  return reply.status(200).send({
    success: true,
    message: "Reasignacion processed",
    data: result.data,
  });
}

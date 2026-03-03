import type { FastifyRequest, FastifyReply } from "fastify";
import type { OrphanParamsType, OrphanRetryBodyType } from "../../schemas/webhooks/orphan.schema.js";
import { retryOrphanEvent } from "../../services/webhooks/orphan.service.js";

export async function handleRetryOrphan(
  request: FastifyRequest<{
    Params: OrphanParamsType;
    Body: OrphanRetryBodyType;
  }>,
  reply: FastifyReply,
): Promise<void> {
  const idHuerfano = parseInt(request.params.id_huerfano, 10);

  if (isNaN(idHuerfano) || idHuerfano <= 0) {
    return reply.status(400).send({
      success: false,
      message: "id_huerfano must be a valid positive integer",
    });
  }

  const { email_corregido } = request.body;

  const result = await retryOrphanEvent(idHuerfano, email_corregido);

  if (!result.success) {
    const status = result.error?.includes("no encontrado") ? 404 : 409;
    return reply.status(status).send({
      success: false,
      message: result.error,
    });
  }

  return reply.status(200).send({
    success: true,
    message: "Orphan event re-dispatched successfully",
    data: result.data,
  });
}

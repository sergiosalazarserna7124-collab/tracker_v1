import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  FathomWebhookPayload,
  FathomParamsType,
  FathomEventBody,
} from "../../schemas/webhooks/fathom.schema.js";
import { processFathomCall } from "../../services/webhooks/fathom.service.js";
import { extractWebhookBody } from "../../utils/payload.utils.js";

export async function handleFathomWebhook(
  request: FastifyRequest<{
    Params: FathomParamsType;
    Body: FathomWebhookPayload;
  }>,
  reply: FastifyReply,
): Promise<void> {
  const idCuenta = parseInt(request.params.id_cuenta, 10);

  if (isNaN(idCuenta) || idCuenta <= 0) {
    return reply.status(400).send({
      success: false,
      message: "id_cuenta must be a valid positive integer",
    });
  }

  // Normaliza formato directo (Fathom nativo) o envuelto en n8n
  const eventBody = extractWebhookBody<FathomEventBody>(request.body);

  if (!eventBody) {
    return reply.status(400).send({
      success: false,
      message: "Missing or invalid Fathom event payload",
    });
  }

  // Procesamiento asíncrono — siempre respondemos 200 para que Fathom
  // no reintente el webhook aunque algún paso interno falle.
  processFathomCall(idCuenta, eventBody).catch((err: unknown) => {
    request.log.error(
      { err, idCuenta },
      "[Fathom] Unhandled error in processFathomCall",
    );
  });

  return reply.status(200).send({
    success: true,
    message: "Fathom webhook received and processing",
  });
}

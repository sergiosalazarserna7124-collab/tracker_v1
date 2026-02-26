import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  FathomWebhookPayload,
  FathomParamsType,
} from "../../schemas/webhooks/fathom.schema.js";
import { processFathomCall } from "../../services/webhooks/fathom.service.js";

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

  // El payload llega envuelto en el array de n8n: [{ body: { ... } }]
  const eventBody = request.body[0]?.body;
  if (!eventBody) {
    return reply.status(400).send({
      success: false,
      message: "Missing body in Fathom event payload",
    });
  }

  // Procesamiento asíncrono — siempre respondemos 200 para que Fathom/n8n
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

import type { FastifyRequest, FastifyReply } from "fastify";
import type { ChatBackfillBodyType } from "../../schemas/quick-triggers/chat-backfill.schema.js";
import { executeChatBackfill } from "../../services/quick-triggers/chat-backfill.service.js";

export async function handleChatBackfill(
  request: FastifyRequest<{ Body: ChatBackfillBodyType }>,
  reply: FastifyReply,
): Promise<void> {
  const idCuenta = request.apiKeyAuth?.idCuenta;
  if (!idCuenta) {
    return reply.status(401).send({ success: false, error: "No autenticado" });
  }

  try {
    const result = await executeChatBackfill(idCuenta, request.body);
    return reply.status(200).send({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    request.log.error({ err, idCuenta }, "[ChatBackfill] Error ejecutando backfill");
    return reply.status(500).send({ success: false, error: message });
  }
}

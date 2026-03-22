import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  ChatRecoveryPreviewBodyType,
  ChatRecoveryExecuteBodyType,
} from "../../schemas/quick-triggers/chat-recovery.schema.js";
import {
  previewChatRecovery,
  executeChatRecovery,
} from "../../services/quick-triggers/chat-recovery.service.js";

export async function handleChatRecoveryPreview(
  request: FastifyRequest<{ Body: ChatRecoveryPreviewBodyType }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const idCuenta = request.apiKeyAuth!.idCuenta;
    const result = await previewChatRecovery(idCuenta, request.body);
    return reply.status(200).send({
      success: true,
      message: "Preview generado",
      data: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error al generar preview";
    return reply.status(422).send({
      success: false,
      message,
    });
  }
}

export async function handleChatRecoveryExecute(
  request: FastifyRequest<{ Body: ChatRecoveryExecuteBodyType }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const idCuenta = request.apiKeyAuth!.idCuenta;
    const result = await executeChatRecovery(idCuenta, request.body);
    return reply.status(200).send({
      success: true,
      message: "Importación completada",
      data: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error al ejecutar chat recovery";
    return reply.status(422).send({
      success: false,
      message,
    });
  }
}

import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  VideoRecoveryExecuteBodyType,
  VideoRecoveryPreviewBodyType,
} from "../../schemas/quick-triggers/video-recovery.schema.js";
import {
  executeVideoRecovery,
  previewVideoRecovery,
} from "../../services/quick-triggers/video-recovery.service.js";

export async function handleVideoRecoveryPreview(
  request: FastifyRequest<{ Body: VideoRecoveryPreviewBodyType }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const idCuenta = request.apiKeyAuth!.idCuenta;
    const result = await previewVideoRecovery(idCuenta, request.body);
    return reply.status(200).send({
      success: true,
      message: "Preview generated",
      data: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed generating preview";
    return reply.status(422).send({
      success: false,
      message,
    });
  }
}

export async function handleVideoRecoveryExecute(
  request: FastifyRequest<{ Body: VideoRecoveryExecuteBodyType }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const idCuenta = request.apiKeyAuth!.idCuenta;
    const result = await executeVideoRecovery(idCuenta, request.body);
    return reply.status(200).send({
      success: true,
      message: "Execution completed",
      data: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed executing video recovery";
    return reply.status(422).send({
      success: false,
      message,
    });
  }
}

import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  VideoRecoveryExecuteBodyType,
  VideoRecoveryPreviewBodyType,
  VideoRecoveryRelinkBodyType,
  VideoRecoveryAgendaSearchBodyType,
} from "../../schemas/quick-triggers/video-recovery.schema.js";
import {
  executeVideoRecovery,
  previewVideoRecovery,
  relinkRecordingToAgenda,
  searchAgendasForRelink,
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

export async function handleVideoRecoveryRelink(
  request: FastifyRequest<{ Body: VideoRecoveryRelinkBodyType }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const idCuenta = request.apiKeyAuth!.idCuenta;
    const result = await relinkRecordingToAgenda(idCuenta, request.body);
    return reply.status(200).send({
      success: true,
      message: "Relink completed",
      data: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed relinking recording to agenda";
    return reply.status(422).send({
      success: false,
      message,
    });
  }
}

export async function handleVideoRecoveryAgendaSearch(
  request: FastifyRequest<{ Body: VideoRecoveryAgendaSearchBodyType }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const idCuenta = request.apiKeyAuth!.idCuenta;
    const result = await searchAgendasForRelink(idCuenta, request.body);
    return reply.status(200).send({
      success: true,
      message: "Agenda search completed",
      data: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed searching agendas";
    return reply.status(422).send({
      success: false,
      message,
    });
  }
}

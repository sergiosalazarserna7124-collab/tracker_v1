import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  ReasignacionWebhookPayload,
  ReasignacionBodyPayload,
} from "../../schemas/webhooks/reasignacion.schema.js";
import { processReasignacion } from "../../services/webhooks/reasignacion.service.js";
import { extractWebhookBody } from "../../utils/payload.utils.js";
import { logWebhookReceived, logWebhookResult } from "../../utils/webhook-logger.js";

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

  const logId = await logWebhookReceived({ fuente: "reasignacion", tipo_evento: "reasignacion", payload_raw: request.body });
  const t0 = Date.now();
  const result = await processReasignacion(eventBody);
  const idCuentaReasig = (result.data as { id_cuenta?: number | null } | undefined)?.id_cuenta ?? null;
  await logWebhookResult(logId, result.data ?? null, result.success ? null : (result.error ?? "error"), Date.now() - t0, idCuentaReasig);

  if (!result.success) {
    return reply.status(422).send({ success: false, message: result.error ?? "Failed to process reasignacion" });
  }
  return reply.status(200).send({ success: true, message: "Reasignacion processed", data: result.data });
}

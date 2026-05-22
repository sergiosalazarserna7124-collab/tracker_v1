import type { FastifyRequest, FastifyReply } from "fastify";
import type { GhlWebhookPayload, GhlBodyPayload } from "../../schemas/webhooks/ghl.schema.js";
import { processGhlWebhook } from "../../services/webhooks/ghl.service.js";
import { extractWebhookBody } from "../../utils/payload.utils.js";
import { logWebhookReceived, logWebhookResult } from "../../utils/webhook-logger.js";
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

  const cd = (body as Record<string, unknown>).customData as Record<string, unknown> | undefined;
  const locationId = (cd?.locationid as string) ?? (body as Record<string, unknown>).locationId as string ?? null;
  const tipoEvento = (body as Record<string, unknown>).type as string ?? "ghl_agenda";

  const logId = await logWebhookReceived({
    fuente: "ghl_agenda",
    tipo_evento: tipoEvento,
    location_id: locationId,
    payload_raw: request.body,
  });

  const t0 = Date.now();
  const result = await processGhlWebhook(body);
  const idCuentaGhl = (result.data as { id_cuenta?: number | null } | undefined)?.id_cuenta ?? null;
  await logWebhookResult(logId, result.data ?? null, result.success ? null : (result.error ?? "error"), Date.now() - t0, idCuentaGhl);

  if (!result.success) {
    return reply.status(422).send({
      success: false,
      message: result.error ?? "Failed to process GHL webhook",
    });
  }

  if (!result.data) {
    return { success: true, message: "GHL event acknowledged (no action required)" };
  }

  return {
    success: true,
    message: "GHL booking registered as PDTE",
    data: result.data,
  };
}

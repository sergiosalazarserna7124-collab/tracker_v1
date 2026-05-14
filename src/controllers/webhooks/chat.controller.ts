import type { FastifyRequest, FastifyReply } from "fastify";
import type { ChatWebhookBody } from "../../schemas/webhooks/chat.schema.js";
import { processChatWebhook } from "../../services/webhooks/chat.service.js";
import { logWebhookReceived, logWebhookResult } from "../../utils/webhook-logger.js";

// ─── POST /webhooks/chat ─────────────────────────────────────────────────────
// Recibe webhooks de la app GHL marketplace (conversations/message.readonly + write).
// Responde 200 inmediatamente y procesa de forma async para no bloquear GHL.

export async function handleChatWebhook(
  request: FastifyRequest<{ Body: ChatWebhookBody }>,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body;

  // locationId puede venir en el body directamente
  const locationId =
    (body.locationId as string | undefined)?.trim() ||
    "";

  if (!locationId) {
    // Log y responder 200 igualmente (GHL no debe reintentar por esto)
    request.log.warn({ body }, "[Chat] Webhook recibido sin locationId");
  }

  const logId = await logWebhookReceived({
    fuente: "chat",
    tipo_evento: body.type as string ?? body.direction ?? null,
    location_id: locationId || null,
    payload_raw: body,
  });
  const t0 = Date.now();

  // Procesar async — GHL no espera respuesta de procesamiento
  processChatWebhook(body, locationId)
    .then((res) => logWebhookResult(logId, res ?? null, null, Date.now() - t0))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logWebhookResult(logId, null, msg, Date.now() - t0).catch(() => {});
      request.log.error({ err, locationId }, "[Chat] Error no capturado en processChatWebhook");
    });

  return reply.status(200).send({
    success: true,
    message: "Chat webhook received and processing",
  });
}

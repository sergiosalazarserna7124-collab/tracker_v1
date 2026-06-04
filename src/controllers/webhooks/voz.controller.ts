import type { FastifyRequest, FastifyReply } from "fastify";
import type { VozCallCompletedPayload } from "../../schemas/webhooks/voz.schema.js";
import { processVozWebhook } from "../../services/webhooks/voz.service.js";
import { logWebhookReceived, logWebhookResult } from "../../utils/webhook-logger.js";

if (!process.env.VOZ_WEBHOOK_SECRET) {
  console.warn("[Voz] ⚠ VOZ_WEBHOOK_SECRET no configurado — todos los requests a /webhooks/voz serán 401");
}

export async function handleVozWebhook(
  request: FastifyRequest<{ Body: VozCallCompletedPayload }>,
  reply: FastifyReply,
): Promise<void> {
  const secret = request.headers["x-voz-secret"];
  const expected = process.env.VOZ_WEBHOOK_SECRET;

  if (!expected || secret !== expected) {
    return reply.status(401).send({ success: false, message: "Unauthorized" });
  }

  const body = request.body;

  const logId = await logWebhookReceived({
    fuente: "voz-callai",
    tipo_evento: body.estado,
    payload_raw: body,
  });
  const t0 = Date.now();

  processVozWebhook(body)
    .then((res) => {
      const idCuenta = (res?.data as { id_cuenta?: number | null } | undefined)?.id_cuenta ?? null;
      return logWebhookResult(logId, res?.data ?? null, res?.success ? null : (res?.error ?? "error"), Date.now() - t0, idCuenta);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logWebhookResult(logId, null, msg, Date.now() - t0).catch(() => {});
      request.log.error({ err }, "[Voz] Error no capturado en processVozWebhook");
    });

  return reply.status(200).send({ success: true, message: "Voz event received and processing" });
}

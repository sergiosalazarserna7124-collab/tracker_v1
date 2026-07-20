import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  MetricasWebhookParamsType,
  MetricasWebhookBodyType,
} from "../../schemas/webhooks/metricas-webhook.schema.js";
import {
  resolveAccountByLocation,
  upsertMetricasWebhook,
} from "../../services/webhooks/metricas-webhook.service.js";
import { logWebhookReceived, logWebhookResult } from "../../utils/webhook-logger.js";
import { env } from "../../config/env.js";

export async function handleMetricasWebhook(
  request: FastifyRequest<{
    Params: MetricasWebhookParamsType;
    Body: MetricasWebhookBodyType;
  }>,
  reply: FastifyReply,
): Promise<void> {
  const { locationid } = request.params;
  const secret = request.headers["x-cron-secret"];

  if (!secret || secret !== env.CRON_SECRET) {
    reply.status(401).send({ success: false, error: "Header x-cron-secret requerido" });
    return;
  }

  const account = await resolveAccountByLocation(locationid);
  if (!account) {
    reply
      .status(404)
      .send({ success: false, error: "location_id no corresponde a ninguna cuenta" });
    return;
  }

  const body = request.body as Record<string, unknown>;

  if (Object.keys(body).length === 0) {
    reply
      .status(400)
      .send({ success: false, error: "Body vacío — envía al menos un campo numérico" });
    return;
  }

  const logId = await logWebhookReceived({
    fuente: "metricas_webhook",
    tipo_evento: "metricas",
    location_id: locationid,
    id_cuenta: account.id_cuenta,
    payload_raw: body,
  });

  const t0 = Date.now();
  const result = await upsertMetricasWebhook(
    account.id_cuenta,
    account.zona_horaria_iana,
    body,
  );
  await logWebhookResult(logId, { processed: result.processed, campos: result.campos_guardados }, null, Date.now() - t0);

  reply.status(200).send({
    success: true,
    message: `Se guardaron ${result.processed} campo(s) para ${result.fecha}`,
    campos_guardados: result.campos_guardados,
    fecha: result.fecha,
    atribuido_a: result.atribuido_a,
  });
}

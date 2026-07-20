import type { FastifyInstance } from "fastify";
import {
  MetricasWebhookParams,
  type MetricasWebhookParamsType,
  type MetricasWebhookBodyType,
} from "../../schemas/webhooks/metricas-webhook.schema.js";
import { handleMetricasWebhook } from "../../controllers/webhooks/metricas-webhook.controller.js";

export async function metricasWebhookRoute(app: FastifyInstance) {
  app.post<{ Params: MetricasWebhookParamsType; Body: MetricasWebhookBodyType }>(
    "/metricas/:locationid",
    {
      schema: {
        params: MetricasWebhookParams,
      },
    },
    handleMetricasWebhook,
  );
}

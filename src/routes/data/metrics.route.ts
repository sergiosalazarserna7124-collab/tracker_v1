/**
 * Ruta: GET /api/v1/metrics/monthly-summary
 *
 * AUT-417: agrega metricDataPoints por mes.
 */

import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import {
  handleGetMonthlySummary,
  type MetricsMonthlySummaryQuerystring,
} from "../../controllers/data/metrics.controller.js";

export async function metricsRoute(app: FastifyInstance) {
  app.get<{ Querystring: MetricsMonthlySummaryQuerystring }>(
    "/monthly-summary",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        querystring: {
          type: "object",
          required: ["from", "to"],
          properties: {
            "metricIds[]": {
              oneOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } },
              ],
            },
            from: { type: "string", pattern: "^\\d{4}-(?:0[1-9]|1[0-2])$" },
            to:   { type: "string", pattern: "^\\d{4}-(?:0[1-9]|1[0-2])$" },
          },
        },
      },
    },
    handleGetMonthlySummary,
  );
}

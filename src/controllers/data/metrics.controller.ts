/**
 * Controller: GET /api/v1/metrics/monthly-summary
 *
 * AUT-417: agrega metricDataPoints por mes para comparaciones entre meses.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { getMonthlySummary } from "../../services/data/metrics.service.js";

export interface MetricsMonthlySummaryQuerystring {
  "metricIds[]"?: string | string[];
  from: string;
  to: string;
}

/** Parse metricIds[] query param — Fastify may deliver it as string or string[] */
function parseMetricIds(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return [raw];
}

/** Validate YYYY-MM format */
function isValidYearMonth(s: string): boolean {
  return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(s);
}

export async function handleGetMonthlySummary(
  request: FastifyRequest<{ Querystring: MetricsMonthlySummaryQuerystring }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = request.apiKeyAuth;
  if (!auth) {
    reply.status(401).send({ success: false, error: "Unauthorized" });
    return;
  }
  const tenantId = auth.idCuenta;
  const { from, to } = request.query;
  const metricIds = parseMetricIds(request.query["metricIds[]"]);

  if (!isValidYearMonth(from)) {
    reply.status(400).send({ success: false, error: "Parámetro 'from' debe tener formato YYYY-MM" });
    return;
  }

  if (!isValidYearMonth(to)) {
    reply.status(400).send({ success: false, error: "Parámetro 'to' debe tener formato YYYY-MM" });
    return;
  }

  if (from > to) {
    reply.status(400).send({ success: false, error: "'from' no puede ser posterior a 'to'" });
    return;
  }

  if (metricIds.length === 0) {
    reply.status(400).send({ success: false, error: "Se requiere al menos un 'metricIds[]'" });
    return;
  }

  const data = await getMonthlySummary(tenantId, metricIds, from, to);
  reply.send({ success: true, data });
}

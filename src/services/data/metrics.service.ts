/**
 * Service: métricas mensuales por tenant.
 *
 * AUT-417: GET /api/v1/metrics/monthly-summary
 */

import { sql, and, eq, inArray, gte, lte } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { metrics, metricDataPoints } from "../../db/schema.js";

export interface MonthEntry {
  month: string; // "YYYY-MM"
  sum: number;
  count: number;
  avg: number;
}

export interface MetricMonthlySummary {
  metricId: string;
  metricName: string;
  months: MonthEntry[];
}

/**
 * Construye el rango [from, to] en timestamp para el filtro BETWEEN.
 * from: primer instante del mes inicial
 * to: último instante del mes final (primer instante del mes siguiente - 1ms)
 */
function buildDateRange(from: string, to: string): { fromTs: Date; toTs: Date } {
  const fromTs = new Date(`${from}-01T00:00:00.000Z`);
  const [toYear, toMonth] = to.split("-").map(Number) as [number, number];
  const toTs = new Date(Date.UTC(toYear, toMonth, 1) - 1);
  return { fromTs, toTs };
}

/**
 * Returns monthly aggregates for each metricId, filtered by tenantId.
 * Only metrics that belong to the tenant are returned (cross-tenant guard).
 */
export async function getMonthlySummary(
  tenantId: number,
  metricIds: string[],
  from: string,
  to: string,
): Promise<MetricMonthlySummary[]> {
  if (metricIds.length === 0) return [];

  const { fromTs, toTs } = buildDateRange(from, to);

  // Verify metrics belong to this tenant (security: no cross-tenant leakage)
  const ownedMetrics = await drizzleDb
    .select({ id: metrics.id, name: metrics.name })
    .from(metrics)
    .where(
      and(
        eq(metrics.id_cuenta, tenantId),
        inArray(metrics.id, metricIds),
      ),
    );

  if (ownedMetrics.length === 0) return [];

  const ownedIds = ownedMetrics.map((m) => m.id);

  // Aggregate by metric_id + month
  const rows = await drizzleDb
    .select({
      metric_id: metricDataPoints.metric_id,
      month: sql<string>`to_char(date_trunc('month', ${metricDataPoints.ts}), 'YYYY-MM')`,
      sum: sql<string>`SUM(${metricDataPoints.value}::numeric)`,
      count: sql<string>`COUNT(*)`,
      avg: sql<string>`AVG(${metricDataPoints.value}::numeric)`,
    })
    .from(metricDataPoints)
    .where(
      and(
        eq(metricDataPoints.id_cuenta, tenantId),
        inArray(metricDataPoints.metric_id, ownedIds),
        gte(metricDataPoints.ts, fromTs),
        lte(metricDataPoints.ts, toTs),
      ),
    )
    .groupBy(
      metricDataPoints.metric_id,
      sql`date_trunc('month', ${metricDataPoints.ts})`,
    )
    .orderBy(
      metricDataPoints.metric_id,
      sql`date_trunc('month', ${metricDataPoints.ts})`,
    );

  // Group rows by metric_id
  const byMetric = new Map<string, MonthEntry[]>();
  for (const row of rows) {
    const entries = byMetric.get(row.metric_id) ?? [];
    entries.push({
      month: row.month,
      sum: Number(row.sum),
      count: Number(row.count),
      avg: Number(Number(row.avg).toFixed(4)),
    });
    byMetric.set(row.metric_id, entries);
  }

  return ownedMetrics.map((m) => ({
    metricId: m.id,
    metricName: m.name,
    months: byMetric.get(m.id) ?? [],
  }));
}

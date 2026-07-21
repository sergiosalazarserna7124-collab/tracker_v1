import { eq, sql } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { cuentas } from "../../db/schema.js";
import type { MatchedRule } from "./reglas-evaluator.service.js";

interface MetricConfig {
  id: string;
  tipo?: string;
  webhookCampo?: string;
}

interface DedupEntry {
  date?: string;
  keys?: string[];
}

function dateInTz(ts: Date, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ts);
    const y = parts.find((p) => p.type === "year")!.value;
    const m = parts.find((p) => p.type === "month")!.value;
    const d = parts.find((p) => p.type === "day")!.value;
    return `${y}-${m}-${d}`;
  } catch {
    return ts.toISOString().slice(0, 10);
  }
}

export async function applyReglasMetricActions(
  matchedRules: MatchedRule[],
  idCuenta: number,
  label: string,
  opts?: { eventTs?: Date; eventKey?: string | null },
): Promise<void> {
  const metricActions: Array<{ metrica_id: string; metrica_incremento: number }> = [];

  for (const rule of matchedRules) {
    for (const accion of rule.acciones) {
      if (accion.tipo === "incrementar_metrica" && accion.metrica_id) {
        metricActions.push({
          metrica_id: accion.metrica_id,
          metrica_incremento: accion.metrica_incremento ?? 1,
        });
      }
    }
  }

  if (metricActions.length === 0) return;

  try {
    const [cuentaRow] = await drizzleDb
      .select({
        metricas_config: cuentas.metricas_config,
        metricas_manual_data: cuentas.metricas_manual_data,
        zona_horaria_iana: cuentas.zona_horaria_iana,
      })
      .from(cuentas)
      .where(eq(cuentas.id_cuenta, idCuenta))
      .limit(1);

    const metricasConfig = (Array.isArray(cuentaRow?.metricas_config) ? cuentaRow.metricas_config : []) as MetricConfig[];
    const configById = new Map(metricasConfig.map((m) => [m.id, m]));

    const dedupData = (cuentaRow?.metricas_manual_data ?? {}) as Record<string, DedupEntry[]>;
    const tz = cuentaRow?.zona_horaria_iana ?? "UTC";
    const eventTs = opts?.eventTs ?? new Date();
    const bucketDate = dateInTz(eventTs, tz);
    const eventKey = opts?.eventKey ?? null;

    let dedupDirty = false;

    for (const { metrica_id, metrica_incremento } of metricActions) {
      const entries = (dedupData[metrica_id] ?? []) as DedupEntry[];
      let dayEntry = entries.find((e) => e.date === bucketDate);

      if (eventKey) {
        if (dayEntry?.keys?.includes(eventKey)) continue;
      }

      const cfg = configById.get(metrica_id);
      const webhookCampo = cfg?.webhookCampo;

      if (webhookCampo) {
        await drizzleDb.execute(sql`
          INSERT INTO metricas_webhook (id_cuenta, fecha, campo, valor, ghl_user_id, updated_at)
          VALUES (${idCuenta}, ${bucketDate}, ${webhookCampo}, ${String(metrica_incremento)}, NULL, NOW())
          ON CONFLICT (id_cuenta, fecha, campo) WHERE ghl_user_id IS NULL DO UPDATE
          SET valor = metricas_webhook.valor + ${String(metrica_incremento)},
              updated_at = NOW()
        `);
      }

      if (dayEntry) {
        if (eventKey) {
          dayEntry.keys = dayEntry.keys ?? [];
          dayEntry.keys.push(eventKey);
        }
      } else {
        dayEntry = { date: bucketDate };
        if (eventKey) dayEntry.keys = [eventKey];
        entries.push(dayEntry);
      }
      dedupData[metrica_id] = entries;
      dedupDirty = true;
    }

    if (dedupDirty) {
      await drizzleDb
        .update(cuentas)
        .set({ metricas_manual_data: dedupData })
        .where(eq(cuentas.id_cuenta, idCuenta));
    }
  } catch (err) {
    console.error(`${label} Error incrementando métrica custom:`, err);
  }
}

export function collectFunnelStages(matchedRules: MatchedRule[]): string | null {
  for (const rule of matchedRules) {
    for (const accion of rule.acciones) {
      if (accion.funnelStage) {
        return accion.funnelStage;
      }
    }
  }
  return null;
}

export function collectCategoria(matchedRules: MatchedRule[]): string | null {
  for (const rule of matchedRules) {
    for (const accion of rule.acciones) {
      if (accion.tipo === "asignar_categoria" && accion.categoria_id) {
        return accion.categoria_id;
      }
    }
  }
  return null;
}

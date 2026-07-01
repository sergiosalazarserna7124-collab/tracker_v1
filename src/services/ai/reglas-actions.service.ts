import { eq } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { cuentas } from "../../db/schema.js";
import type { MatchedRule } from "./reglas-evaluator.service.js";

export async function applyReglasMetricActions(
  matchedRules: MatchedRule[],
  idCuenta: number,
  label: string,
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
      .select({ metricas_manual_data: cuentas.metricas_manual_data })
      .from(cuentas)
      .where(eq(cuentas.id_cuenta, idCuenta))
      .limit(1);

    const currentData = (cuentaRow?.metricas_manual_data ?? {}) as Record<string, unknown[]>;
    const today = new Date().toISOString().slice(0, 10);

    for (const { metrica_id, metrica_incremento } of metricActions) {
      const entries = currentData[metrica_id] ?? [];
      const todayIdx = (entries as Array<{ date?: string; valor?: number }>).findIndex(
        (e) => e.date === today,
      );
      if (todayIdx >= 0) {
        (entries as Array<{ date?: string; valor?: number }>)[todayIdx].valor =
          ((entries as Array<{ date?: string; valor?: number }>)[todayIdx].valor ?? 0) + metrica_incremento;
      } else {
        (entries as Array<{ date?: string; valor?: number }>).push({ date: today, valor: metrica_incremento });
      }
      currentData[metrica_id] = entries;
    }

    await drizzleDb
      .update(cuentas)
      .set({ metricas_manual_data: currentData })
      .where(eq(cuentas.id_cuenta, idCuenta));
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

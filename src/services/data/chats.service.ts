import { db } from "../../config/database.js";
import { drizzleDb } from "../../config/drizzle.js";
import { cuentas } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import type { MetricaConfig, MetricaConfigChat, ChatMetricaResultado } from "../../types/metricas.js";

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface ChatRow {
  id_evento: number;
  id_cuenta: number;
  fecha_y_hora_z: string | null;
  estado: string | null;
  origen: string | null;
  asesor_asignado: string | null;
  ia_categoria: string | null;
  ia_objeciones: unknown;
  tags_internos: unknown;
  primer_msg_lead_at: string | null;
}

// ─── Cómputo de métricas custom tipo "chat" ───────────────────────────────────

/**
 * Calcula una sola métrica tipo "chat" sobre una lista de filas de chats_logs.
 *
 * Campos mapeables:
 *   - ia_categoria:    string (categoría AI del chat)
 *   - estado:          string ('activo', 'cerrado', etc.)
 *   - origen:          string (canal: 'SMS', 'WhatsApp', 'FB', etc.)
 *   - asesor_asignado: string (nombre del asesor)
 *   - tags_internos:   string[] (etiquetas internas)
 *   - ia_objeciones:   Array<{objecion, categoria}> (objeciones detectadas)
 */
export function computeChatMetrica(
  rows: ChatRow[],
  config: MetricaConfigChat,
): ChatMetricaResultado {
  const { id, nombre, chatCampo, chatAgregacion, chatFiltroValor } = config;

  // Aplicar filtro opcional antes de agregar
  const filtered = chatFiltroValor
    ? rows.filter((r) => {
        const v = r[chatCampo as keyof ChatRow];
        if (Array.isArray(v)) return (v as string[]).includes(chatFiltroValor);
        return v === chatFiltroValor;
      })
    : rows;

  if (chatAgregacion === "count") {
    return { id, nombre, tipo: "chat", valor: filtered.length };
  }

  if (chatAgregacion === "count_distinct") {
    const values = new Set<string>();
    for (const row of filtered) {
      const v = row[chatCampo as keyof ChatRow];
      if (typeof v === "string" && v) values.add(v);
    }
    return { id, nombre, tipo: "chat", valor: values.size };
  }

  if (chatAgregacion === "count_by_value") {
    const counts: Record<string, number> = {};
    for (const row of filtered) {
      const v = row[chatCampo as keyof ChatRow];
      if (chatCampo === "tags_internos") {
        const tags = Array.isArray(v) ? (v as string[]) : [];
        for (const tag of tags) {
          counts[tag] = (counts[tag] ?? 0) + 1;
        }
      } else if (chatCampo === "ia_objeciones") {
        const objs = Array.isArray(v)
          ? (v as Array<{ objecion?: string; categoria?: string }>)
          : [];
        for (const obj of objs) {
          const cat = obj.categoria ?? "otra";
          counts[cat] = (counts[cat] ?? 0) + 1;
        }
      } else if (typeof v === "string" && v) {
        counts[v] = (counts[v] ?? 0) + 1;
      }
    }
    return { id, nombre, tipo: "chat", valor: counts };
  }

  if (chatAgregacion === "avg_response_time") {
    // Tiempo promedio entre fecha_y_hora_z y primer_msg_lead_at (en minutos)
    const tiempos: number[] = [];
    for (const row of filtered) {
      if (row.primer_msg_lead_at && row.fecha_y_hora_z) {
        const lead = new Date(row.primer_msg_lead_at).getTime();
        const inicio = new Date(row.fecha_y_hora_z).getTime();
        if (!isNaN(lead) && !isNaN(inicio) && lead > inicio) {
          tiempos.push((lead - inicio) / 60_000);
        }
      }
    }
    const avg =
      tiempos.length > 0
        ? Math.round(tiempos.reduce((a, b) => a + b, 0) / tiempos.length)
        : 0;
    return { id, nombre, tipo: "chat", valor: avg };
  }

  return { id, nombre, tipo: "chat", valor: 0 };
}

// ─── Servicio principal ───────────────────────────────────────────────────────

export interface GetChatsParams {
  idCuenta: number;
  /** Fecha inicio YYYY-MM-DD (UTC) */
  desde?: string;
  /** Fecha fin YYYY-MM-DD (UTC) */
  hasta?: string;
}

export interface GetChatsResult {
  chats: ChatRow[];
  metricasCustom: ChatMetricaResultado[];
  total: number;
}

export async function getChatsData(params: GetChatsParams): Promise<GetChatsResult> {
  const { idCuenta, desde, hasta } = params;

  // ── 1. Obtener metricas_config de la cuenta ─────────────────────────────
  const [cuenta] = await drizzleDb
    .select({ metricas_config: cuentas.metricas_config })
    .from(cuentas)
    .where(eq(cuentas.id_cuenta, idCuenta))
    .limit(1);

  const metricasConfig: MetricaConfig[] = Array.isArray(cuenta?.metricas_config)
    ? (cuenta.metricas_config as MetricaConfig[])
    : [];

  const chatMetricasConfig = metricasConfig.filter(
    (m): m is MetricaConfigChat => m.tipo === "chat",
  );

  // ── 2. Obtener chats_logs ───────────────────────────────────────────────
  const conditions: string[] = ["id_cuenta = $1"];
  const values: unknown[] = [idCuenta];

  if (desde) {
    values.push(desde);
    conditions.push(`fecha_y_hora_z >= $${values.length}::date`);
  }
  if (hasta) {
    values.push(hasta);
    conditions.push(`fecha_y_hora_z < ($${values.length}::date + INTERVAL '1 day')`);
  }

  const where = conditions.join(" AND ");

  const { rows } = await db.query<ChatRow>(
    `SELECT
       id_evento, id_cuenta, fecha_y_hora_z, estado, origen,
       asesor_asignado, ia_categoria, ia_objeciones, tags_internos,
       primer_msg_lead_at
     FROM chats_logs
     WHERE ${where}
     ORDER BY fecha_y_hora_z DESC`,
    values,
  );

  // ── 3. Calcular métricas custom ─────────────────────────────────────────
  const metricasCustom: ChatMetricaResultado[] = chatMetricasConfig.map((config) =>
    computeChatMetrica(rows, config),
  );

  return { chats: rows, metricasCustom, total: rows.length };
}

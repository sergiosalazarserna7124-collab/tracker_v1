import { db } from "../../config/database.js";
import { drizzleDb } from "../../config/drizzle.js";
import { cuentas } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import type {
  MetricaConfig,
  MetricaConfigChat,
  MetricaConfigChatKeyword,
  ChatMetricaResultado,
} from "../../types/metricas.js";
import {
  esCalificado,
  parseCriteriosCalificacion,
  type CriteriosCalificacion,
} from "./criterios-calificacion.utils.js";

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface ChatMessage {
  role?: string;
  name?: string;
  message?: string;
  timestamp?: string;
  _ghl_source?: string;
}

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
  bot_delegacion_at: string | null;
  es_calificado: boolean;
  excluido_metricas: boolean;
  calificacion_manual: string | null;
}

interface ChatRowWithTranscript extends ChatRow {
  chat: ChatMessage[] | null;
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
        const raw = v as unknown;
        const objs: Array<{ objecion?: string; categoria?: string }> = Array.isArray(raw)
          ? raw
          : (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).objeciones))
            ? (raw as Record<string, unknown>).objeciones as Array<{ objecion?: string; categoria?: string }>
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

  if (chatAgregacion === "speed_post_bot") {
    const BOT_SOURCES = new Set(["workflow", "api", "campaign"]);
    const tiempos: number[] = [];
    for (const row of filtered) {
      if (!row.bot_delegacion_at) continue;
      const delegacionMs = new Date(row.bot_delegacion_at).getTime();
      if (isNaN(delegacionMs)) continue;
      const transcript = (row as ChatRowWithTranscript).chat;
      if (!Array.isArray(transcript)) continue;
      let firstHumanAgentTs: number | null = null;
      for (const msg of transcript) {
        if (msg.role !== "agent" || !msg.timestamp) continue;
        if (BOT_SOURCES.has(msg._ghl_source ?? "")) continue;
        const ts = new Date(msg.timestamp).getTime();
        if (!isNaN(ts) && ts > delegacionMs) {
          if (firstHumanAgentTs === null || ts < firstHumanAgentTs) {
            firstHumanAgentTs = ts;
          }
        }
      }
      if (firstHumanAgentTs !== null) {
        tiempos.push((firstHumanAgentTs - delegacionMs) / 60_000);
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

// ─── Keyword matching helpers ─────────────────────────────────────────────────

const ACCENT_MAP: Record<string, string> = {
  á: "a", é: "e", í: "i", ó: "o", ú: "u", ü: "u",
  à: "a", è: "e", ì: "i", ò: "o", ù: "u",
  ä: "a", ë: "e", ï: "i", ö: "o",
  â: "a", ê: "e", î: "i", ô: "o", û: "u",
  ñ: "n",
};

function removeAccents(text: string): string {
  return text.replace(/[áéíóúüàèìòùäëïöâêîôûñ]/g, (ch) => ACCENT_MAP[ch] ?? ch);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildKeywordRegex(keywords: string[], normalizeAccents: boolean): RegExp {
  const patterns = keywords.map((kw) => {
    let escaped = escapeRegex(kw.toLowerCase());
    if (normalizeAccents) escaped = removeAccents(escaped);
    return `\\b${escaped}\\b`;
  });
  return new RegExp(patterns.join("|"), "gi");
}

function extractTexts(
  messages: ChatMessage[],
  scope: "mensajes_lead" | "todo_el_chat",
): string[] {
  const texts: string[] = [];
  for (const msg of messages) {
    if (!msg.message) continue;
    if (scope === "todo_el_chat" || msg.role === "lead") {
      texts.push(msg.message);
    }
  }
  return texts;
}

export function computeKeywordMetrica(
  rows: ChatRowWithTranscript[],
  config: MetricaConfigChatKeyword,
): ChatMetricaResultado {
  const { id, nombre, keywords } = config;
  const matchScope = config.matchScope ?? "mensajes_lead";
  const countMode = config.countMode ?? "chats";
  const normalizeAccents = config.normalizeAccents !== false;

  if (!keywords.length) {
    return { id, nombre, tipo: "chat", valor: 0 };
  }

  const regex = buildKeywordRegex(keywords, normalizeAccents);

  let total = 0;

  for (const row of rows) {
    const messages = Array.isArray(row.chat) ? row.chat : [];
    const texts = extractTexts(messages, matchScope);

    let chatMatches = 0;
    for (const text of texts) {
      const haystack = normalizeAccents
        ? removeAccents(text.toLowerCase())
        : text.toLowerCase();
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(haystack)) !== null) {
        chatMatches++;
        if (countMode === "chats") break;
      }
      if (countMode === "chats" && chatMatches > 0) break;
    }

    if (countMode === "chats") {
      total += chatMatches > 0 ? 1 : 0;
    } else {
      total += chatMatches;
    }
  }

  return { id, nombre, tipo: "chat", valor: total };
}

// ─── Type guard for keyword configs ──────────────────────────────────────────

function isKeywordConfig(m: MetricaConfig): m is MetricaConfigChatKeyword {
  return m.tipo === "chat" && "chatSubtipo" in m && (m as MetricaConfigChatKeyword).chatSubtipo === "conteo_keyword";
}

function isStandardChatConfig(m: MetricaConfig): m is MetricaConfigChat {
  return m.tipo === "chat" && !("chatSubtipo" in m);
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

  // ── 1. Obtener metricas_config y criterios_calificacion de la cuenta ───────
  const [cuenta] = await drizzleDb
    .select({
      metricas_config: cuentas.metricas_config,
      criterios_calificacion: cuentas.criterios_calificacion,
    })
    .from(cuentas)
    .where(eq(cuentas.id_cuenta, idCuenta))
    .limit(1);

  const metricasConfig: MetricaConfig[] = Array.isArray(cuenta?.metricas_config)
    ? (cuenta.metricas_config as MetricaConfig[])
    : [];

  // Parsear criterios_calificacion; null → todos calificados (backward compat)
  let criterios: CriteriosCalificacion | null = null;
  if (cuenta?.criterios_calificacion !== null && cuenta?.criterios_calificacion !== undefined) {
    try {
      criterios = parseCriteriosCalificacion(cuenta.criterios_calificacion);
    } catch {
      criterios = null;
    }
  }

  const standardChatConfigs = metricasConfig.filter(isStandardChatConfig);
  const keywordConfigs = metricasConfig.filter(isKeywordConfig);
  const needTranscript = keywordConfigs.length > 0
    || standardChatConfigs.some(c => c.chatAgregacion === "speed_post_bot");

  // ── 2. Obtener chats_logs ───────────────────────────────────────────────
  const conditions: string[] = ["id_cuenta = $1", "excluida_dashboard = false"];
  const values: unknown[] = [idCuenta];

  if (desde) {
    values.push(desde);
    conditions.push(`primer_msg_lead_at >= $${values.length}::date`);
  }
  if (hasta) {
    values.push(hasta);
    conditions.push(`primer_msg_lead_at < ($${values.length}::date + INTERVAL '1 day')`);
  }

  const where = conditions.join(" AND ");

  const chatColumn = needTranscript ? ", chat" : "";

  // ChatRowRaw = resultado directo de BD, sin es_calificado
  interface ChatRowRaw extends Omit<ChatRow, "es_calificado"> {
    chat?: ChatMessage[] | null;
  }

  const { rows: rawRows } = await db.query<ChatRowRaw>(
    `SELECT
       id_evento, id_cuenta, fecha_y_hora_z, estado, origen,
       asesor_asignado, ia_categoria, ia_objeciones, tags_internos,
       primer_msg_lead_at, bot_delegacion_at, COALESCE(excluido_metricas, false) AS excluido_metricas,
       calificacion_manual${chatColumn}
     FROM chats_logs
     WHERE ${where}
     ORDER BY primer_msg_lead_at DESC`,
    values,
  );

  // ── 3. Enriquecer con es_calificado ─────────────────────────────────────
  const rows: ChatRow[] = rawRows.map((r) => ({
    ...r,
    excluido_metricas: Boolean(r.excluido_metricas),
    calificacion_manual: r.calificacion_manual ?? null,
    es_calificado: esCalificado(r.ia_categoria, criterios, "chats", r.calificacion_manual),
  }));

  // ── 4. Calcular métricas custom ─────────────────────────────────────────
  const metricasCustom: ChatMetricaResultado[] = standardChatConfigs.map((config) =>
    computeChatMetrica(rows, config),
  );

  // ── 4b. Calcular métricas keyword (requieren transcript) ───────────────
  if (keywordConfigs.length > 0) {
    const rowsWithTranscript: ChatRowWithTranscript[] = rawRows.map((r) => ({
      ...r,
      chat: Array.isArray(r.chat) ? r.chat : null,
      es_calificado: esCalificado(r.ia_categoria, criterios, "chats", r.calificacion_manual),
    }));
    for (const config of keywordConfigs) {
      metricasCustom.push(computeKeywordMetrica(rowsWithTranscript, config));
    }
  }

  return { chats: rows, metricasCustom, total: rows.length };
}

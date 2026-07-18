import { db as pgPool } from "../../config/database.js";
import { withRetry } from "../../utils/retry.utils.js";
import { analyzeChatWithAI } from "../ai/chat-analysis.service.js";
import { parseCriteriosCalificacion } from "../data/criterios-calificacion.utils.js";

// Minimum messages (from lead) required before attempting inline classification
const MIN_LEAD_MESSAGES = 2;

interface AccountConfigRow {
  openai_api_key: string | null;
  prompt_ventas: string | null;
  embudo_personalizado: unknown;
  criterios_calificacion: unknown;
  reglas_etiquetas: unknown;
  canales_activos: unknown;
}

interface ChatRow {
  id_evento: number;
  chat: unknown;
  ia_categoria: string | null;
}

/**
 * Attempts to classify a chat inline (at ingest time) if it hasn't been classified yet
 * and has enough lead messages for meaningful classification.
 *
 * This is fire-and-forget — errors are logged but never propagated.
 * Prevents the "metrics drift" where MQL/SQL counts change for past days
 * because the batch cron classified chats hours after they arrived.
 */
export async function tryInlineChatClassification(
  conversationId: string,
  idCuenta: number,
): Promise<void> {
  try {
    // 1. Check if chat needs classification
    const chatResult = await withRetry(
      () => pgPool.query<ChatRow>(
        `SELECT id_evento, chat, ia_categoria
         FROM chats_logs
         WHERE chatid = $1 AND id_cuenta = $2`,
        [conversationId, idCuenta],
      ),
      { label: "inlineClassify/getChat" },
    );

    const chatRow = chatResult.rows[0];
    if (!chatRow) return;
    if (chatRow.ia_categoria !== null) return;

    const messages = Array.isArray(chatRow.chat)
      ? (chatRow.chat as Array<{ role: string; message: string; timestamp: string; name?: string }>)
      : [];

    const leadMessages = messages.filter((m) => m.role === "lead");
    if (leadMessages.length < MIN_LEAD_MESSAGES) return;

    // 2. Load account config
    const configResult = await withRetry(
      () => pgPool.query<AccountConfigRow>(
        `SELECT openai_api_key, prompt_ventas, embudo_personalizado,
                criterios_calificacion, reglas_etiquetas, canales_activos
         FROM cuentas WHERE id_cuenta = $1`,
        [idCuenta],
      ),
      { label: "inlineClassify/getConfig" },
    );

    const config = configResult.rows[0];
    if (!config) return;

    const embudo = Array.isArray(config.embudo_personalizado)
      ? (config.embudo_personalizado as Array<{ id: string; nombre: string; condition?: string; fuentes?: string[] }>)
      : [];

    const embudoChat = embudo.filter((e) =>
      !e.fuentes || e.fuentes.length === 0 || e.fuentes.some((f) => ["chat", "chats", "todas"].includes(f)),
    );

    const reglasEtiquetas = Array.isArray(config.reglas_etiquetas)
      ? (config.reglas_etiquetas as Array<{ id: string; tag: string; condition: string; source?: string; fuentes?: string[] }>)
      : [];

    let promptCalificacionChats: string | null = null;
    try {
      const criterios = config.criterios_calificacion
        ? parseCriteriosCalificacion(config.criterios_calificacion)
        : null;
      promptCalificacionChats = criterios?.prompt_calificacion_chats ?? null;
    } catch {
      // malformed — skip
    }

    const canalesActivos = Array.isArray(config.canales_activos) ? config.canales_activos as string[] : null;

    // 3. Classify
    const result = await analyzeChatWithAI({
      messages,
      embudo: embudoChat,
      reglas_etiquetas: reglasEtiquetas,
      prompt_empresa: config.prompt_ventas ?? undefined,
      openai_api_key: config.openai_api_key ?? undefined,
      id_cuenta: idCuenta,
      canales_activos: canalesActivos,
      prompt_calificacion_chats: promptCalificacionChats,
    });

    // 4. Update — only if still unclassified (race-safe with COALESCE)
    await pgPool.query(
      `UPDATE chats_logs
       SET ia_categoria = COALESCE(ia_categoria, $1),
           ia_analizado_at = COALESCE(ia_analizado_at, NOW()),
           ia_objeciones = COALESCE(ia_objeciones, $2::jsonb)
       WHERE id_evento = $3 AND ia_categoria IS NULL`,
      [
        result.categoria ?? "analizado_sin_categoria",
        result.objeciones.length > 0 ? JSON.stringify(result.objeciones) : null,
        chatRow.id_evento,
      ],
    );

    console.info(
      `[inlineClassify] chat=${chatRow.id_evento} cuenta=${idCuenta} → "${result.categoria}" (confianza=${result.confianza})`,
    );
  } catch (err) {
    console.error(`[inlineClassify] Error para conversationId="${conversationId}" cuenta=${idCuenta}:`, err);
  }
}

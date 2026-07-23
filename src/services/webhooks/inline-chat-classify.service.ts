import { db as pgPool } from "../../config/database.js";
import { withRetry } from "../../utils/retry.utils.js";
import { analyzeChatWithAI } from "../ai/chat-analysis.service.js";
import { evaluateReglas, type DynamicValueContext } from "../ai/reglas-evaluator.service.js";
import { parseCriteriosCalificacion } from "../data/criterios-calificacion.utils.js";

// Classify on the very first lead message to prevent night-drift (AUT-1706)
const MIN_LEAD_MESSAGES = 1;

interface AccountConfigRow {
  openai_api_key: string | null;
  prompt_ventas: string | null;
  embudo_personalizado: unknown;
  criterios_calificacion: unknown;
  reglas_etiquetas: unknown;
  canales_activos: unknown;
  token_ghl: string | null;
  locationid: string | null;
}

interface ChatRow {
  id_evento: number;
  chat: unknown;
  ia_categoria: string | null;
  id_lead: string | null;
}

type ChatMessage = { role: string; message: string; timestamp: string; name?: string };

function formatChatAsTranscript(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const role = m.role === "lead" ? "Lead" : m.role === "agent" ? "Asesor" : m.role;
      const name = m.name ? ` (${m.name})` : "";
      return `${role}${name}: ${m.message ?? ""}`;
    })
    .join("\n");
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
  ghlContext?: { contactId?: string | null; tokenGhl?: string | null; locationId?: string | null },
): Promise<void> {
  try {
    // 1. Check if chat needs classification
    const chatResult = await withRetry(
      () => pgPool.query<ChatRow>(
        `SELECT id_evento, chat, ia_categoria, id_lead
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
      ? (chatRow.chat as ChatMessage[])
      : [];

    const leadMessages = messages.filter((m) => m.role === "lead");
    if (leadMessages.length < MIN_LEAD_MESSAGES) return;

    // 2. Load account config
    const configResult = await withRetry(
      () => pgPool.query<AccountConfigRow>(
        `SELECT openai_api_key, prompt_ventas, embudo_personalizado,
                criterios_calificacion, reglas_etiquetas, canales_activos,
                token_ghl, locationid
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

    // 5. Run reglas GHL-write actions for chats (AUT-1781)
    const contactId = ghlContext?.contactId ?? chatRow.id_lead;
    const bearerToken = ghlContext?.tokenGhl ?? config.token_ghl;
    const locationId = ghlContext?.locationId ?? config.locationid;

    if (contactId && bearerToken && reglasEtiquetas.length > 0) {
      const hasGhlWriteReglas = reglasEtiquetas.some((r) => {
        const matchesChat = !r.fuentes || r.fuentes.length === 0 ||
          r.fuentes.some((f: string) => ["chat", "chats", "todas"].includes(f));
        if (!matchesChat) return false;
        const acciones = Array.isArray((r as Record<string, unknown>).acciones)
          ? (r as Record<string, unknown>).acciones as Array<{ tipo: string }>
          : [{ tipo: (r as Record<string, unknown>).accion ?? "asignar_etiqueta" }];
        return acciones.some((a) =>
          a.tipo === "escribir_campo_ghl" || a.tipo === "escribir_campo_ghl_ia",
        );
      });

      if (hasGhlWriteReglas) {
        try {
          const transcript = formatChatAsTranscript(messages);
          const dynCtx: DynamicValueContext = {
            contactId,
            bearerToken,
            locationId: locationId ?? null,
          };
          await evaluateReglas(
            transcript,
            reglasEtiquetas,
            "chat",
            config.prompt_ventas ?? null,
            config.openai_api_key,
            idCuenta,
            dynCtx,
          );
          console.info(
            `[inlineClassify] GHL-write reglas executed for chat=${chatRow.id_evento} cuenta=${idCuenta} contact=${contactId}`,
          );
        } catch (err) {
          console.error(`[inlineClassify] Error running GHL-write reglas for chat=${chatRow.id_evento}:`, err);
        }
      }
    }
  } catch (err) {
    console.error(`[inlineClassify] Error para conversationId="${conversationId}" cuenta=${idCuenta}:`, err);
  }
}

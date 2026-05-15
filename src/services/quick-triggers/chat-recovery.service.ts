import { eq, and } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { db } from "../../config/database.js";
import { cuentas } from "../../db/schema.js";
import { fetchWithTimeout } from "../../utils/fetch.utils.js";
import { withRetry } from "../../utils/retry.utils.js";
import type {
  ChatRecoveryPreviewBodyType,
  ChatRecoveryExecuteBodyType,
} from "../../schemas/quick-triggers/chat-recovery.schema.js";

// ─── Constantes ───────────────────────────────────────────────────────────────

const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const GHL_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 50;

// Mapa de tipo GHL → label de canal (messageType numérico para conversaciones)
const CHANNEL_TYPE_MAP: Record<string, string> = {
  TYPE_PHONE: "SMS",
  TYPE_EMAIL: "Email",
  TYPE_FB_MESSENGER: "FB",
  TYPE_INSTAGRAM: "IG",
  TYPE_WHATSAPP: "WhatsApp",
  TYPE_LIVE_CHAT: "Live_Chat",
  TYPE_GMB: "GMB",
  TYPE_CUSTOM_EMAIL: "Email",
  // Numérico (por si acaso)
  "1": "SMS",
  "2": "Email",
  "3": "FB",
  "4": "IG",
  "5": "WhatsApp",
  "6": "Live_Chat",
  "10": "GMB",
};

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface GhlConversation {
  id: string;
  contactId: string;
  contactName?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  lastMessage?: string | null;
  lastMessageDate?: string | null;
  type?: string | number | null;
  channel?: string | null;
  assignedTo?: string | null;
}

interface GhlConversationsSearchResponse {
  conversations: GhlConversation[];
  total?: number;
}

interface GhlMessage {
  id: string;
  conversationId: string;
  contactId?: string | null;
  userId?: string | null;
  body?: string | null;
  direction: "inbound" | "outbound";
  type?: string | number | null;
  status?: string | null;
  dateAdded?: string | null;
  source?: string | null;
}

interface GhlMessagesResponse {
  messages?: {
    messages?: GhlMessage[];
  };
  lastMessageId?: string | null;
}

export interface ChatRecoveryPreviewItem {
  conversationId: string;
  contactId: string;
  contactName: string;
  lastMessage: string;
  lastMessageDate: string;
  channel: string;
  existeEnBD: boolean;
  mensajesEnBD: number;
  mensajesEnGHL: number;
  accion: "importar_nuevo" | "actualizar_existente" | "ya_completo";
}

interface ChatMessageObj {
  name: string;
  role: "lead" | "agent";
  type: string;
  status: string;
  message: string;
  timestamp: string;
  _ghl_message_id: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildBearerAuth(rawToken: string): string {
  const t = rawToken.trim();
  return /^bearer\s+/i.test(t) ? t : `Bearer ${t}`;
}

function resolveContactName(conv: GhlConversation): string {
  const fromContactName = conv.contactName?.trim();
  if (fromContactName) return fromContactName;
  const fromFullName = conv.fullName?.trim();
  if (fromFullName) return fromFullName;
  const fromParts = [conv.firstName, conv.lastName].filter(Boolean).join(" ").trim();
  return fromParts || "Lead";
}

function resolveChannelLabel(conv: GhlConversation): string {
  const raw = String(conv.type ?? conv.channel ?? "").trim();
  return CHANNEL_TYPE_MAP[raw] ?? (raw || "Desconocido");
}

function resolveMessageChannelLabel(msgType: string | number | null | undefined): string {
  const raw = String(msgType ?? "").trim();
  return CHANNEL_TYPE_MAP[raw] ?? (raw || "WhatsApp");
}

// ─── Resolver cuenta GHL ──────────────────────────────────────────────────────

async function resolveGhlAccount(idCuenta: number): Promise<{
  locationId: string;
  bearerToken: string;
} | null> {
  const [row] = await drizzleDb
    .select({
      locationid: cuentas.locationid,
      token_ghl: cuentas.token_ghl,
    })
    .from(cuentas)
    .where(eq(cuentas.id_cuenta, idCuenta))
    .limit(1);

  if (!row?.locationid || !row.token_ghl) return null;

  return {
    locationId: row.locationid,
    bearerToken: buildBearerAuth(row.token_ghl),
  };
}

// ─── API GHL: listar conversaciones ──────────────────────────────────────────

async function fetchGhlConversations(
  bearerToken: string,
  locationId: string,
  limit: number,
): Promise<GhlConversation[]> {
  const params = new URLSearchParams({
    locationId,
    limit: String(limit),
    sortBy: "lastMessageDate",
    sortOrder: "desc",
  });

  const response = await fetchWithTimeout(
    `${GHL_BASE_URL}/conversations/search?${params.toString()}`,
    {
      method: "GET",
      headers: {
        Authorization: bearerToken,
        Version: GHL_VERSION,
        "Content-Type": "application/json",
      },
    },
    GHL_TIMEOUT_MS,
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GHL conversations/search ${response.status}: ${detail}`);
  }

  const json = (await response.json()) as GhlConversationsSearchResponse;
  return Array.isArray(json.conversations) ? json.conversations : [];
}

// ─── API GHL: obtener mensajes de una conversación ────────────────────────────

async function fetchGhlMessages(
  bearerToken: string,
  conversationId: string,
  limit = 100,
): Promise<GhlMessage[]> {
  const params = new URLSearchParams({ limit: String(limit) });

  const response = await fetchWithTimeout(
    `${GHL_BASE_URL}/conversations/${conversationId}/messages?${params.toString()}`,
    {
      method: "GET",
      headers: {
        Authorization: bearerToken,
        Version: GHL_VERSION,
        "Content-Type": "application/json",
      },
    },
    GHL_TIMEOUT_MS,
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GHL messages ${response.status} for ${conversationId}: ${detail}`);
  }

  const json = (await response.json()) as GhlMessagesResponse;
  // La respuesta de GHL anida messages.messages
  const msgs = json.messages?.messages;
  return Array.isArray(msgs) ? msgs : [];
}

// ─── BD: contar mensajes existentes en chats_logs ─────────────────────────────

interface ChatBdInfo {
  exists: boolean;
  mensajesEnBD: number;
}

async function queryChatBdInfo(conversationIds: string[]): Promise<Map<string, ChatBdInfo>> {
  if (conversationIds.length === 0) return new Map();

  const placeholders = conversationIds.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await withRetry(
    () =>
      db.query<{ chatid: string; mensaje_count: string }>(
        `SELECT chatid, jsonb_array_length(chat) AS mensaje_count
         FROM chats_logs
         WHERE chatid IN (${placeholders})`,
        conversationIds,
      ),
    { label: "chatRecovery/queryChatBdInfo" },
  );

  const result = new Map<string, ChatBdInfo>();
  for (const row of rows) {
    result.set(row.chatid, {
      exists: true,
      mensajesEnBD: Number(row.mensaje_count) || 0,
    });
  }
  return result;
}

// ─── Preview ─────────────────────────────────────────────────────────────────

export async function previewChatRecovery(
  idCuenta: number,
  body: ChatRecoveryPreviewBodyType,
): Promise<{ items: ChatRecoveryPreviewItem[] }> {
  const account = await resolveGhlAccount(idCuenta);
  if (!account) {
    throw new Error("La cuenta no tiene locationId o token GHL configurado.");
  }

  const limit = Math.min(body.limit ?? DEFAULT_LIMIT, 100);
  const conversations = await fetchGhlConversations(
    account.bearerToken,
    account.locationId,
    limit,
  );

  // Filtro de canal si aplica
  const filtered =
    body.channel_filter && body.channel_filter !== "all"
      ? conversations.filter(
          (conv) =>
            resolveChannelLabel(conv).toLowerCase() === body.channel_filter!.toLowerCase(),
        )
      : conversations;

  const conversationIds = filtered.map((c) => c.id);
  const bdInfoMap = await queryChatBdInfo(conversationIds);

  // Para el preview obtenemos el conteo de mensajes en GHL en paralelo (máximo 5 concurrentes)
  const CONCURRENCY = 5;
  const items: ChatRecoveryPreviewItem[] = [];

  for (let i = 0; i < filtered.length; i += CONCURRENCY) {
    const batch = filtered.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (conv) => {
        const contactName = resolveContactName(conv);
        const channel = resolveChannelLabel(conv);
        const bdInfo = bdInfoMap.get(conv.id) ?? { exists: false, mensajesEnBD: 0 };

        let mensajesEnGHL = 0;
        try {
          const msgs = await fetchGhlMessages(account.bearerToken, conv.id, 100);
          mensajesEnGHL = msgs.length;
        } catch {
          mensajesEnGHL = 0;
        }

        let accion: ChatRecoveryPreviewItem["accion"];
        if (!bdInfo.exists) {
          accion = "importar_nuevo";
        } else if (mensajesEnGHL > bdInfo.mensajesEnBD) {
          accion = "actualizar_existente";
        } else {
          accion = "ya_completo";
        }

        return {
          conversationId: conv.id,
          contactId: conv.contactId,
          contactName,
          lastMessage: (conv.lastMessage ?? "").slice(0, 120),
          lastMessageDate: conv.lastMessageDate ?? "",
          channel,
          existeEnBD: bdInfo.exists,
          mensajesEnBD: bdInfo.mensajesEnBD,
          mensajesEnGHL,
          accion,
        } satisfies ChatRecoveryPreviewItem;
      }),
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        items.push(result.value);
      }
    }
  }

  return { items };
}

// ─── Execute ─────────────────────────────────────────────────────────────────

interface ExecuteItemResult {
  conversationId: string;
  contactName: string;
  status: "insertado" | "actualizado" | "sin_cambios" | "error";
  mensajesImportados: number;
  motivo: string;
}

export async function executeChatRecovery(
  idCuenta: number,
  body: ChatRecoveryExecuteBodyType,
): Promise<{
  procesadas: number;
  insertadas: number;
  actualizadas: number;
  errores: number;
  items: ExecuteItemResult[];
}> {
  const account = await resolveGhlAccount(idCuenta);
  if (!account) {
    throw new Error("La cuenta no tiene locationId o token GHL configurado.");
  }

  const results: ExecuteItemResult[] = [];
  const seen = new Set<string>();

  for (const conv of body.selected_conversations) {
    if (seen.has(conv.conversationId)) {
      results.push({
        conversationId: conv.conversationId,
        contactName: conv.contactName,
        status: "error",
        mensajesImportados: 0,
        motivo: "conversationId duplicado en el mismo request.",
      });
      continue;
    }
    seen.add(conv.conversationId);

    try {
      // 1. Obtener mensajes de GHL
      const ghlMessages = await fetchGhlMessages(account.bearerToken, conv.conversationId, 100);

      if (ghlMessages.length === 0) {
        results.push({
          conversationId: conv.conversationId,
          contactName: conv.contactName,
          status: "sin_cambios",
          mensajesImportados: 0,
          motivo: "No se encontraron mensajes en GHL para esta conversación.",
        });
        continue;
      }

      // 2. Mapear mensajes al formato de chats_logs.chat
      const chatMessages: ChatMessageObj[] = ghlMessages.map((msg) => {
        const isInbound = msg.direction === "inbound";
        return {
          name: isInbound ? conv.contactName : "Agente",
          role: isInbound ? "lead" : "agent",
          type: resolveMessageChannelLabel(msg.type),
          status: msg.status ?? "delivered",
          message: msg.body ?? "",
          timestamp: msg.dateAdded
            ? new Date(msg.dateAdded).toISOString()
            : new Date().toISOString(),
          _ghl_message_id: msg.id,
        };
      });

      // 3. Verificar estado actual en BD
      const bdInfo = await queryChatBdInfo([conv.conversationId]);
      const existente = bdInfo.get(conv.conversationId);

      // 4. Calcular primer_msg_lead_at: timestamp mínimo de mensajes inbound (lead)
      const leadTimestamps = chatMessages
        .filter((m) => m.role === "lead" && m.timestamp)
        .map((m) => m.timestamp)
        .sort();
      const primerMsgLeadAt = leadTimestamps[0] ?? null;

      // 5. Upsert en chats_logs con deduplicación por _ghl_message_id
      // Insertamos todos los mensajes nuevos usando un CASE WHEN que comprueba
      // si cada _ghl_message_id ya existe en el array existente
      const messagesJson = JSON.stringify(chatMessages);

      await withRetry(
        () =>
          db.query(
            `INSERT INTO chats_logs
               (id_cuenta, nombre_lead, id_lead, chatid, fecha_y_hora_z, estado, notas_extra, chat, primer_msg_lead_at)
             VALUES ($1, $2, $3, $4, NOW(), 'activo', NULL, $5::jsonb, $6::timestamptz)
             ON CONFLICT (chatid) DO UPDATE SET
               chat = (
                 SELECT jsonb_agg(msg ORDER BY (msg->>'timestamp') ASC NULLS LAST)
                 FROM (
                   -- mensajes existentes
                   SELECT msg FROM jsonb_array_elements(chats_logs.chat) AS msg
                   UNION ALL
                   -- mensajes nuevos que no existen aún (deduplicación por _ghl_message_id)
                   SELECT msg FROM jsonb_array_elements(EXCLUDED.chat) AS msg
                   WHERE NOT EXISTS (
                     SELECT 1 FROM jsonb_array_elements(chats_logs.chat) AS existing
                     WHERE existing->>'_ghl_message_id' = msg->>'_ghl_message_id'
                   )
                 ) AS combined(msg)
               ),
               fecha_y_hora_z = NOW(),
               nombre_lead    = EXCLUDED.nombre_lead,
               -- Inmutable: solo se escribe si aún no existe (primer mensaje lead)
               primer_msg_lead_at = COALESCE(chats_logs.primer_msg_lead_at, EXCLUDED.primer_msg_lead_at)`,
            [
              idCuenta,
              conv.contactName,
              conv.contactId,
              conv.conversationId,
              messagesJson,
              primerMsgLeadAt,
            ],
          ),
        { label: `chatRecovery/upsert/${conv.conversationId}` },
      );

      const status: ExecuteItemResult["status"] = existente?.exists
        ? "actualizado"
        : "insertado";

      results.push({
        conversationId: conv.conversationId,
        contactName: conv.contactName,
        status,
        mensajesImportados: chatMessages.length,
        motivo: existente?.exists
          ? `Conversación actualizada con ${chatMessages.length} mensajes de GHL.`
          : `Conversación importada con ${chatMessages.length} mensajes de GHL.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error desconocido";
      results.push({
        conversationId: conv.conversationId,
        contactName: conv.contactName,
        status: "error",
        mensajesImportados: 0,
        motivo: message,
      });
    }
  }

  return {
    procesadas: results.filter((r) => r.status !== "error").length,
    insertadas: results.filter((r) => r.status === "insertado").length,
    actualizadas: results.filter((r) => r.status === "actualizado").length,
    errores: results.filter((r) => r.status === "error").length,
    items: results,
  };
}

import { db as pgPool } from "../../config/database.js";
import { withRetry } from "../../utils/retry.utils.js";
import { fetchWithTimeout } from "../../utils/fetch.utils.js";
import { getAccessToken } from "../oauth/ghl-oauth.service.js";

const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const GHL_TIMEOUT_MS = 30_000;
const MAX_CHATS_PER_RUN = 100;
const MAX_RUNTIME_MS = 240_000;
const LOOKBACK_DAYS = 30;

interface ChatNeedingEnrichment {
  id_evento: number;
  id_cuenta: number;
  chatid: string;
  nombre_lead: string;
}

interface AccountInfo {
  id_cuenta: number;
  token_ghl: string;
  locationid: string;
}

interface GhlMessage {
  id: string;
  body?: string | null;
  direction: "inbound" | "outbound";
  type?: string | number | null;
  status?: string | null;
  dateAdded?: string | null;
  source?: string | null;
  userId?: string | null;
}

const CHANNEL_TYPE_MAP: Record<string, string> = {
  "1": "SMS", "2": "Email", "3": "FB", "4": "IG",
  "5": "WhatsApp", "6": "Live_Chat", "10": "GMB",
};

function resolveChannelLabel(raw: string | number | null | undefined): string {
  const s = String(raw ?? "").trim();
  return CHANNEL_TYPE_MAP[s] ?? (s || "WhatsApp");
}

function buildBearerAuth(rawToken: string): string {
  const t = rawToken.trim();
  return /^bearer\s+/i.test(t) ? t : `Bearer ${t}`;
}

async function fetchMessages(
  bearerToken: string,
  conversationId: string,
): Promise<GhlMessage[]> {
  const params = new URLSearchParams({ limit: "100" });
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
    throw new Error(`GHL messages ${response.status}: ${detail}`);
  }

  const json = (await response.json()) as { messages?: { messages?: GhlMessage[] } };
  return json.messages?.messages ?? [];
}

export interface OutboundEnrichmentResult {
  chatsScanned: number;
  chatsEnriched: number;
  messagesAdded: number;
  chatsNoOutbound: number;
  errors: number;
}

export async function runOutboundEnrichment(): Promise<OutboundEnrichmentResult> {
  const startTime = Date.now();
  const result: OutboundEnrichmentResult = {
    chatsScanned: 0,
    chatsEnriched: 0,
    messagesAdded: 0,
    chatsNoOutbound: 0,
    errors: 0,
  };

  const chatsResult = await withRetry(
    () =>
      pgPool.query<ChatNeedingEnrichment>(
        `SELECT cl.id_evento, cl.id_cuenta, cl.chatid, cl.nombre_lead
         FROM chats_logs cl
         JOIN cuentas c ON c.id_cuenta = cl.id_cuenta
         WHERE cl.asesor_asignado IS NOT NULL AND cl.asesor_asignado != ''
           AND cl.excluida_dashboard = false
           AND cl.outbound_enriched_at IS NULL
           AND cl.fecha_y_hora_z > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(cl.chat) e WHERE e->>'role' = 'agent'
           )
           AND c.token_ghl IS NOT NULL AND c.token_ghl != ''
           AND (c.estado_cuenta NOT IN ('cancelado', 'inactivo') OR c.estado_cuenta IS NULL)
         ORDER BY cl.fecha_y_hora_z DESC
         LIMIT ${MAX_CHATS_PER_RUN}`,
      ),
    { label: "outboundEnrichment/findChats" },
  );

  const chats = chatsResult.rows;
  if (chats.length === 0) {
    console.info("[outboundEnrichment] No chats need enrichment");
    return result;
  }

  console.info(`[outboundEnrichment] ${chats.length} chats to enrich`);

  const accountIds = [...new Set(chats.map((c) => c.id_cuenta))];
  const accountsResult = await withRetry(
    () =>
      pgPool.query<AccountInfo>(
        `SELECT id_cuenta, token_ghl, locationid
         FROM cuentas
         WHERE id_cuenta = ANY($1::int[])`,
        [accountIds],
      ),
    { label: "outboundEnrichment/getAccounts" },
  );
  const accountMap = new Map(accountsResult.rows.map((a) => [a.id_cuenta, a]));

  for (const chat of chats) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      console.warn("[outboundEnrichment] Circuit breaker — stopping");
      break;
    }

    result.chatsScanned++;
    const account = accountMap.get(chat.id_cuenta);
    const ghlToken = account ? ((await getAccessToken(account.locationid ?? "")) || account.token_ghl) : null;
    if (!ghlToken) continue;

    try {
      const bearerToken = buildBearerAuth(ghlToken);
      const messages = await fetchMessages(bearerToken, chat.chatid);

      const outboundMessages = messages.filter((m) => m.direction === "outbound");

      if (outboundMessages.length === 0) {
        result.chatsNoOutbound++;
        await withRetry(
          () =>
            pgPool.query(
              `UPDATE chats_logs SET outbound_enriched_at = NOW()
               WHERE id_evento = $1`,
              [chat.id_evento],
            ),
          { label: `outboundEnrichment/markNoOutbound/${chat.id_evento}` },
        );
        continue;
      }

      const chatMessages = outboundMessages.map((msg) => ({
        name: "Agente",
        role: "agent" as const,
        type: resolveChannelLabel(msg.type),
        status: msg.status ?? "sent",
        message: msg.body ?? "",
        timestamp: msg.dateAdded
          ? new Date(msg.dateAdded).toISOString()
          : new Date().toISOString(),
        _ghl_message_id: msg.id,
        _ghl_source: msg.source ?? null,
        _ghl_user_id: msg.userId ?? null,
      }));

      await withRetry(
        () =>
          pgPool.query(
            `UPDATE chats_logs SET
               chat = (
                 SELECT jsonb_agg(msg ORDER BY (msg->>'timestamp') ASC NULLS LAST)
                 FROM (
                   SELECT msg FROM jsonb_array_elements(chat) AS msg
                   UNION ALL
                   SELECT msg FROM jsonb_array_elements($2::jsonb) AS msg
                   WHERE NOT EXISTS (
                     SELECT 1 FROM jsonb_array_elements(chats_logs.chat) AS existing
                     WHERE existing->>'_ghl_message_id' = msg->>'_ghl_message_id'
                   )
                 ) AS combined(msg)
               ),
               outbound_enriched_at = NOW()
             WHERE id_evento = $1`,
            [chat.id_evento, JSON.stringify(chatMessages)],
          ),
        { label: `outboundEnrichment/merge/${chat.id_evento}` },
      );

      result.chatsEnriched++;
      result.messagesAdded += chatMessages.length;
      console.info(
        `[outboundEnrichment] Chat ${chat.id_evento} (${chat.nombre_lead}): +${chatMessages.length} outbound msgs`,
      );
    } catch (err) {
      result.errors++;
      console.error(`[outboundEnrichment] Error enriching chat ${chat.id_evento}:`, err);
    }
  }

  console.info(
    `[outboundEnrichment] Done: ${result.chatsScanned} scanned, ${result.chatsEnriched} enriched, ` +
    `${result.messagesAdded} msgs added, ${result.chatsNoOutbound} no outbound, ${result.errors} errors`,
  );
  return result;
}

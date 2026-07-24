import { eq } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { db } from "../../config/database.js";
import { cuentas } from "../../db/schema.js";
import { fetchWithTimeout } from "../../utils/fetch.utils.js";
import { withRetry } from "../../utils/retry.utils.js";
import { tryInlineChatClassification } from "../webhooks/inline-chat-classify.service.js";
import type { ChatBackfillBodyType } from "../../schemas/quick-triggers/chat-backfill.schema.js";

const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const GHL_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const BATCH_CONCURRENCY = 5;

interface GhlConversation {
  id: string;
  contactId: string;
  contactName?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  lastMessageDate?: number | null;
  type?: string | number | null;
  channel?: string | null;
  assignedTo?: string | null;
  sort?: number[];
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
  messages?: { messages?: GhlMessage[] };
  lastMessageId?: string | null;
}

const CHANNEL_TYPE_MAP: Record<string, string> = {
  TYPE_PHONE: "SMS",
  TYPE_EMAIL: "Email",
  TYPE_FB_MESSENGER: "FB",
  TYPE_INSTAGRAM: "IG",
  TYPE_WHATSAPP: "WhatsApp",
  TYPE_LIVE_CHAT: "Live_Chat",
  TYPE_GMB: "GMB",
  TYPE_CUSTOM_EMAIL: "Email",
  TYPE_CUSTOM_SMS: "WhatsApp",
  "1": "SMS", "2": "Email", "3": "FB", "4": "IG",
  "5": "WhatsApp", "6": "Live_Chat", "10": "GMB",
};

function buildBearerAuth(rawToken: string): string {
  const t = rawToken.trim();
  return /^bearer\s+/i.test(t) ? t : `Bearer ${t}`;
}

function resolveContactName(conv: GhlConversation): string {
  return conv.contactName?.trim() || conv.fullName?.trim() ||
    [conv.firstName, conv.lastName].filter(Boolean).join(" ").trim() || "Lead";
}

function resolveChannelLabel(raw: string | number | null | undefined): string {
  const s = String(raw ?? "").trim();
  return CHANNEL_TYPE_MAP[s] ?? (s || "WhatsApp");
}

async function fetchConversationsPage(
  bearerToken: string,
  locationId: string,
  searchAfter?: number,
): Promise<GhlConversation[]> {
  const params = new URLSearchParams({
    locationId,
    limit: String(PAGE_SIZE),
  });
  if (searchAfter !== undefined) {
    params.set("startAfterDate", String(searchAfter));
  }

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

  const json = (await response.json()) as { conversations?: GhlConversation[] };
  return Array.isArray(json.conversations) ? json.conversations : [];
}

async function fetchAllMessages(
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

  const json = (await response.json()) as GhlMessagesResponse;
  return json.messages?.messages ?? [];
}

async function getExistingChatIds(
  idCuenta: number,
  chatIds: string[],
): Promise<Set<string>> {
  if (chatIds.length === 0) return new Set();
  const placeholders = chatIds.map((_, i) => `$${i + 2}`).join(", ");
  const { rows } = await withRetry(
    () =>
      db.query<{ chatid: string }>(
        `SELECT chatid FROM chats_logs WHERE id_cuenta = $1 AND chatid IN (${placeholders})`,
        [idCuenta, ...chatIds],
      ),
    { label: "chatBackfill/getExisting" },
  );
  return new Set(rows.map((r) => r.chatid));
}

async function upsertConversation(
  idCuenta: number,
  conv: GhlConversation,
  messages: GhlMessage[],
): Promise<{ status: "inserted" | "updated" | "empty"; count: number }> {
  if (messages.length === 0) return { status: "empty", count: 0 };

  const contactName = resolveContactName(conv);

  const chatMessages = messages.map((msg) => {
    const isInbound = msg.direction === "inbound";
    return {
      name: isInbound ? contactName : "Agente",
      role: isInbound ? "lead" : "agent",
      type: resolveChannelLabel(msg.type),
      status: msg.status ?? "delivered",
      message: msg.body ?? "",
      timestamp: msg.dateAdded
        ? new Date(msg.dateAdded).toISOString()
        : new Date().toISOString(),
      _ghl_message_id: msg.id,
    };
  });

  const leadTimestamps = chatMessages
    .filter((m) => m.role === "lead" && m.timestamp)
    .map((m) => m.timestamp)
    .sort();
  const primerMsgLeadAt = leadTimestamps[0] ?? null;

  const allTimestamps = chatMessages
    .filter((m) => m.timestamp)
    .map((m) => m.timestamp)
    .sort();
  const primerMsgAt = allTimestamps[0] ?? new Date().toISOString();

  const channelType = resolveChannelLabel(conv.type);

  await withRetry(
    () =>
      db.query(
        `INSERT INTO chats_logs
           (id_cuenta, nombre_lead, id_lead, chatid, fecha_y_hora_z, estado, chat, origen, primer_msg_lead_at, primer_msg_at)
         VALUES ($1, $2, $3, $4, NOW(), 'activo', $5::jsonb, $6, $7::timestamptz, $8::timestamptz)
         ON CONFLICT (chatid) DO UPDATE SET
           chat = (
             SELECT jsonb_agg(msg ORDER BY (msg->>'timestamp') ASC NULLS LAST)
             FROM (
               SELECT msg FROM jsonb_array_elements(chats_logs.chat) AS msg
               UNION ALL
               SELECT msg FROM jsonb_array_elements(EXCLUDED.chat) AS msg
               WHERE NOT EXISTS (
                 SELECT 1 FROM jsonb_array_elements(chats_logs.chat) AS existing
                 WHERE existing->>'_ghl_message_id' = msg->>'_ghl_message_id'
               )
             ) AS combined(msg)
           ),
           fecha_y_hora_z = NOW(),
           nombre_lead = EXCLUDED.nombre_lead,
           primer_msg_lead_at = COALESCE(chats_logs.primer_msg_lead_at, EXCLUDED.primer_msg_lead_at),
           primer_msg_at = COALESCE(chats_logs.primer_msg_at, EXCLUDED.primer_msg_at),
           excluida_dashboard = chats_logs.excluida_dashboard`,
        [
          idCuenta,
          contactName,
          conv.contactId,
          conv.id,
          JSON.stringify(chatMessages),
          channelType,
          primerMsgLeadAt,
          primerMsgAt,
        ],
      ),
    { label: `chatBackfill/upsert/${conv.id}` },
  );

  return { status: "inserted", count: chatMessages.length };
}

export interface ChatBackfillResult {
  idCuenta: number;
  sinceDate: string;
  totalConversationsScanned: number;
  newConversations: number;
  updatedConversations: number;
  totalMessagesImported: number;
  errors: number;
  dryRun: boolean;
  errorDetails: string[];
}

export async function executeChatBackfill(
  idCuenta: number,
  body: ChatBackfillBodyType,
): Promise<ChatBackfillResult> {
  const [account] = await drizzleDb
    .select({ locationid: cuentas.locationid, token_ghl: cuentas.token_ghl })
    .from(cuentas)
    .where(eq(cuentas.id_cuenta, idCuenta))
    .limit(1);

  if (!account?.locationid || !account.token_ghl) {
    throw new Error("Cuenta sin locationId o token GHL configurado.");
  }

  const bearerToken = buildBearerAuth(account.token_ghl);
  const sinceMs = new Date(body.since_date).getTime();
  const maxConvs = body.max_conversations ?? 500;
  const dryRun = body.dry_run ?? false;

  const result: ChatBackfillResult = {
    idCuenta,
    sinceDate: body.since_date,
    totalConversationsScanned: 0,
    newConversations: 0,
    updatedConversations: 0,
    totalMessagesImported: 0,
    errors: 0,
    dryRun,
    errorDetails: [],
  };

  const allConversations: GhlConversation[] = [];
  let cursor: number | undefined;
  let pageNum = 0;

  while (allConversations.length < maxConvs) {
    pageNum++;
    console.log(`[ChatBackfill] Fetching page ${pageNum} for cuenta ${idCuenta} (cursor=${cursor ?? "none"})...`);

    const page = await fetchConversationsPage(bearerToken, account.locationid, cursor);
    if (page.length === 0) break;

    let reachedCutoff = false;
    for (const conv of page) {
      const lastMsg = conv.lastMessageDate ?? 0;
      if (lastMsg < sinceMs) {
        reachedCutoff = true;
        break;
      }
      allConversations.push(conv);
      if (allConversations.length >= maxConvs) break;
    }

    if (reachedCutoff || page.length < PAGE_SIZE) break;

    const lastConv = page[page.length - 1];
    cursor = lastConv?.sort?.[0] ?? lastConv?.lastMessageDate ?? undefined;
    if (!cursor) break;
  }

  result.totalConversationsScanned = allConversations.length;
  console.log(`[ChatBackfill] Found ${allConversations.length} conversations since ${body.since_date} for cuenta ${idCuenta}`);

  if (dryRun) return result;

  const convIds = allConversations.map((c) => c.id);
  const existingIds = await getExistingChatIds(idCuenta, convIds);

  for (let i = 0; i < allConversations.length; i += BATCH_CONCURRENCY) {
    const batch = allConversations.slice(i, i + BATCH_CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (conv) => {
        const messages = await fetchAllMessages(bearerToken, conv.id);
        const existed = existingIds.has(conv.id);
        const res = await upsertConversation(idCuenta, conv, messages);
        if (res.status === "empty") return;
        if (existed) {
          result.updatedConversations++;
        } else {
          result.newConversations++;
        }
        result.totalMessagesImported += res.count;

        // Run inline classification + GHL-write rules (e.g. escribir_campo_ghl_ia)
        // for newly imported conversations (AUT-1816)
        if (!existed && messages.some((m) => m.direction === "inbound")) {
          void tryInlineChatClassification(conv.id, idCuenta, {
            contactId: conv.contactId,
            tokenGhl: account.token_ghl,
            locationId: account.locationid,
          });
        }
      }),
    );

    for (const r of batchResults) {
      if (r.status === "rejected") {
        result.errors++;
        result.errorDetails.push(String(r.reason));
      }
    }

    if (i + BATCH_CONCURRENCY < allConversations.length) {
      console.log(`[ChatBackfill] Progress: ${Math.min(i + BATCH_CONCURRENCY, allConversations.length)}/${allConversations.length}`);
    }
  }

  console.log(`[ChatBackfill] Done for cuenta ${idCuenta}: ${result.newConversations} new, ${result.updatedConversations} updated, ${result.totalMessagesImported} messages, ${result.errors} errors`);
  return result;
}

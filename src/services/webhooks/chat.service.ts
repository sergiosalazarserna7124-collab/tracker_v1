import { eq } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { db } from "../../config/database.js";
import { cuentas, eventosHuerfanos } from "../../db/schema.js";
import { getAccountByLocationId, getGhlUser } from "../ghl-api.service.js";
import { fetchWithTimeout } from "../../utils/fetch.utils.js";
import { withRetry } from "../../utils/retry.utils.js";
import type { ChatWebhookBody } from "../../schemas/webhooks/chat.schema.js";
import type { ServiceResult } from "../../types/index.js";

// ─── Constantes ───────────────────────────────────────────────────────────────

const GHL_TIMEOUT_MS = 12_000;

// Tipos de evento que se procesan (mensajes reales, inbound y outbound)
const PROCESSABLE_EVENT_TYPES = new Set([
  "InboundMessage",
  "OutboundMessage",
  // Algunos webhooks de la app marketplace llegan sin type explícito
  // pero con direction, por eso type undefined también pasa (ver lógica abajo)
]);

// Mapa de canal: message.type (number) → string label
// Fuente: GHL marketplace docs
const CHANNEL_MAP: Record<number, string> = {
  1: "SMS",
  2: "Email",
  3: "FB",
  4: "IG",
  5: "WhatsApp",
  6: "Live_Chat",
  7: "WhatsApp",
  10: "GMB",
  12: "Custom",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildBearerAuth(rawToken: string): string {
  const t = rawToken.trim();
  return /^bearer\s+/i.test(t) ? t : `Bearer ${t}`;
}

/**
 * Fallback: buscar cuenta por locationid con ILIKE cuando el exact match falla.
 * Replica el similarity(locationid, locationId) > 0.6 que usaba n8n.
 */
async function getAccountByLocationIdFallback(locationId: string) {
  // Primero exact match via Drizzle (la función estándar)
  const exact = await getAccountByLocationId(locationId);
  if (exact) return exact;

  // Fallback ILIKE (por si el locationId viene con distinta capitalización)
  const { rows } = await withRetry(
    () =>
      db.query<{
        id_cuenta: number;
        nombre_cuenta: string | null;
        locationid: string | null;
        token_ghl: string | null;
      }>(
        `SELECT id_cuenta, nombre_cuenta, locationid, token_ghl
         FROM cuentas
         WHERE locationid ILIKE $1
         LIMIT 1`,
        [locationId],
      ),
    { label: "getAccountByLocationIdFallback" },
  );

  return rows[0] ?? null;
}

/**
 * Guarda evento huérfano cuando no se encuentra la cuenta.
 */
async function saveOrphan(
  payload: ChatWebhookBody,
  motivo: string,
): Promise<void> {
  try {
    await withRetry(
      () =>
        drizzleDb.insert(eventosHuerfanos).values({
          id_cuenta: null,
          origen: "chat",
          motivo,
          payload_original: payload as unknown as Record<string, unknown>,
          estado: "pendiente",
        }),
      { label: "chat/saveOrphan" },
    );
  } catch (err) {
    console.error("[Chat] Error guardando evento huérfano:", err);
  }
}

/**
 * Obtener info del contacto desde la API de GHL.
 * Devuelve { fullName, firstName } o null en caso de fallo.
 */
async function fetchGhlContact(
  contactId: string,
  tokenGhl: string,
): Promise<{ fullName: string; firstName: string } | null> {
  try {
    const response = await fetchWithTimeout(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      {
        method: "GET",
        headers: {
          Authorization: buildBearerAuth(tokenGhl),
          Accept: "application/json",
          Version: "2021-07-28",
        },
      },
      GHL_TIMEOUT_MS,
    );

    if (!response.ok) {
      const text = await response.text();
      console.warn(`[Chat] GHL contacts API ${response.status}: ${text}`);
      return null;
    }

    const data = (await response.json()) as {
      contact?: {
        firstName?: string;
        lastName?: string;
        fullName?: string;
        fullNameLowerCase?: string;
        name?: string;
      };
    };

    const c = data.contact;
    if (!c) return null;

    const joinedName = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
    const fullName =
      c.fullName ??
      c.name ??
      (joinedName || null) ??
      c.fullNameLowerCase ??
      "Cliente";

    return {
      fullName: fullName || "Cliente",
      firstName: c.firstName ?? fullName.split(" ")[0] ?? "Cliente",
    };
  } catch (err) {
    console.warn("[Chat] Error fetching GHL contact:", err);
    return null;
  }
}

// ─── Procesador principal ─────────────────────────────────────────────────────

export async function processChatWebhook(
  body: ChatWebhookBody,
  locationId: string,
): Promise<ServiceResult> {
  // ── Logging diagnóstico completo ─────────────────────────────────────────
  console.log("[Chat] ── Webhook recibido ──────────────────────────────────");
  console.log("[Chat] locationId        :", locationId);
  console.log("[Chat] type (evento)     :", body.type ?? "(undefined)");
  console.log("[Chat] direction         :", body.direction ?? body.message?.direction ?? "(undefined)");
  console.log("[Chat] contentType       :", body.contentType ?? "(undefined)");
  console.log("[Chat] status            :", body.status ?? "(undefined)");
  console.log("[Chat] attachments       :", body.attachments !== undefined ? JSON.stringify(body.attachments) : "(no attachments)");
  console.log("[Chat] messageType       :", body.messageType ?? body.message?.messageType ?? "(undefined)");
  console.log("[Chat] conversationId    :", body.conversationId ?? "(undefined)");
  console.log("[Chat] contactId         :", body.contactId ?? "(undefined)");

  // ── 1. Filtro de n8n: solo text/plain + delivered + sin attachments ──────
  const contentType = body.contentType ?? "";
  const status = body.status ?? "";
  const hasAttachments =
    body.attachments !== undefined &&
    body.attachments !== null &&
    !(Array.isArray(body.attachments) && (body.attachments as unknown[]).length === 0);

  if (!contentType.includes("text/plain")) {
    console.log(`[Chat] Ignorado — contentType="${contentType}" (no es text/plain)`);
    return { success: true, data: { skipped: true, reason: "contentType" } };
  }
  if (!status.includes("delivered")) {
    console.log(`[Chat] Ignorado — status="${status}" (no es delivered)`);
    return { success: true, data: { skipped: true, reason: "status" } };
  }
  if (hasAttachments) {
    console.log("[Chat] Ignorado — tiene attachments");
    return { success: true, data: { skipped: true, reason: "attachments" } };
  }

  // ── 2. Filtro de tipo de evento ──────────────────────────────────────────
  const eventType = body.type;
  if (eventType && !PROCESSABLE_EVENT_TYPES.has(eventType)) {
    console.log(`[Chat] Ignorado — tipo de evento="${eventType}" (no es mensaje entrante/saliente)`);
    return { success: true, data: { skipped: true, reason: "eventType" } };
  }

  // ── 3. Extraer campos normalizados (body puede ser flat o anidado) ────────
  const conversationId = body.conversationId;
  const contactId = body.contactId;
  const direction = body.direction ?? body.message?.direction;
  const messageType = body.messageType ?? body.message?.messageType;
  const messageBody = body.body ?? body.message?.body ?? "";
  const messageId = body.id ?? body.message?.id;
  const source = body.source ?? body.message?.source;
  const userId = body.userId ?? body.message?.userId;
  const dateAdded = body.dateAdded ?? body.message?.dateAdded;

  // messageType numérico para mapear canal
  const messageTypeNum = body.message?.type;

  if (!conversationId) {
    console.warn("[Chat] Sin conversationId — ignorando payload sin identificador de chat");
    return { success: true, data: { skipped: true, reason: "no_conversationId" } };
  }

  // ── 4. Determinar canal ────────────────────────────────────────────────────
  let channelType = "Unknown";
  if (messageType) {
    channelType = messageType; // usar messageType string directamente (como n8n)
  } else if (messageTypeNum !== undefined && messageTypeNum !== null) {
    channelType = CHANNEL_MAP[messageTypeNum] ?? `Unknown_${messageTypeNum}`;
    if (!CHANNEL_MAP[messageTypeNum]) {
      console.warn(`[Chat] Canal no mapeado: message.type=${messageTypeNum}`);
    }
  }

  // ── 5. Buscar cuenta ──────────────────────────────────────────────────────
  const account = await getAccountByLocationIdFallback(locationId);
  if (!account) {
    console.warn(`[Chat] Cuenta no encontrada para locationId="${locationId}" → guardando huérfano`);
    await saveOrphan(body, `Cuenta no encontrada para locationId=${locationId}`);
    return { success: true, data: { skipped: true, reason: "account_not_found" } };
  }

  const idCuenta = account.id_cuenta;
  const tokenGhl = account.token_ghl ?? "";

  // ── 6. Obtener nombre del contacto ────────────────────────────────────────
  let contactName = "Cliente";
  let contactFirstName = "Cliente";

  // Primero intentar del objeto contact en el payload
  if (body.contact?.name) {
    contactName = body.contact.name;
    contactFirstName = body.contact.firstName ?? contactName.split(" ")[0] ?? contactName;
  } else if (body.contact?.firstName) {
    contactFirstName = body.contact.firstName;
    contactName = [body.contact.firstName, body.contact.lastName].filter(Boolean).join(" ");
  } else if (body.contact?.fullNameLowerCase) {
    contactFirstName = body.contact.fullNameLowerCase;
    contactName = body.contact.fullNameLowerCase;
  } else if (contactId && tokenGhl) {
    // Fallback: buscar en API de GHL
    const ghlContact = await fetchGhlContact(contactId, tokenGhl);
    if (ghlContact) {
      contactName = ghlContact.fullName;
      contactFirstName = ghlContact.firstName;
    }
  }

  // ── 7. Obtener asesor asignado (best-effort) ──────────────────────────────
  let closerName: string | null = null;
  if (userId && tokenGhl) {
    try {
      const ghlUser = await getGhlUser(userId, tokenGhl);
      if (ghlUser?.name) {
        closerName = ghlUser.name;
      }
    } catch (err) {
      console.warn(`[Chat] No se pudo obtener user userId="${userId}":`, err);
    }
  }

  // ── 8. Determinar role y nombre del emisor (lógica n8n exacta) ────────────
  let senderRole: "lead" | "agent";
  let senderName: string;

  if (direction === "inbound") {
    senderRole = "lead";
    senderName = contactFirstName || contactName || "Cliente";
  } else {
    senderRole = "agent";
    senderName = closerName ?? "Agente";
  }

  console.log(`[Chat] role="${senderRole}" | name="${senderName}" | canal="${channelType}" | conversationId="${conversationId}"`);

  // ── 9. Construir messageObj (estructura exacta que espera el sistema) ──────
  const messageObj = {
    role: senderRole,
    name: senderName,
    message: messageBody,
    timestamp: dateAdded ? new Date(dateAdded).toISOString() : new Date().toISOString(),
    status,
    type: channelType,
    // Campos extra para debugging
    _ghl_message_id: messageId,
    _ghl_source: source,
    _ghl_user_id: userId,
  };

  // ── 10. Upsert en chats_logs (replicando el ON CONFLICT de n8n) ─────────
  await withRetry(
    () =>
      db.query(
        `INSERT INTO chats_logs
           (id_cuenta, nombre_lead, id_lead, chatid, fecha_y_hora_z, estado, notas_extra, chat)
         VALUES ($1, $2, $3, $4, NOW(), 'activo', $5, $6::jsonb)
         ON CONFLICT (chatid) DO UPDATE SET
           chat           = chats_logs.chat || EXCLUDED.chat,
           fecha_y_hora_z = NOW(),
           notas_extra    = COALESCE(EXCLUDED.notas_extra, chats_logs.notas_extra),
           nombre_lead    = EXCLUDED.nombre_lead`,
        [
          idCuenta,
          contactName,
          contactId ?? null,
          conversationId,
          closerName ?? null,
          JSON.stringify([messageObj]),
        ],
      ),
    { label: "chat/upsertChatLog" },
  );

  console.log(`[Chat] ✅ Upsert OK — conversationId="${conversationId}" | id_cuenta=${idCuenta}`);

  return {
    success: true,
    data: {
      conversationId,
      idCuenta,
      role: senderRole,
      channel: channelType,
    },
  };
}

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
 * Como tercer fallback, busca en ghl_oauth_tokens para cuentas que solo tienen OAuth.
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

  if (rows[0]) return rows[0];

  // Tercer fallback: buscar en ghl_oauth_tokens (cuentas que solo tienen OAuth marketplace)
  const { rows: oauthRows } = await withRetry(
    () =>
      db.query<{
        id_cuenta: number | null;
        location_id: string;
      }>(
        `SELECT id_cuenta, location_id FROM ghl_oauth_tokens WHERE location_id = $1 LIMIT 1`,
        [locationId],
      ),
    { label: "getAccountByLocationIdFallback/oauth" },
  );

  if (oauthRows[0]) {
    console.warn(
      `[Chat] locationId="${locationId}" encontrado en ghl_oauth_tokens (solo OAuth, sin cuenta en cuentas). id_cuenta=${oauthRows[0].id_cuenta ?? "null"}`,
    );
    if (oauthRows[0].id_cuenta) {
      // Traer datos de la cuenta linkeada
      const { rows: cuentaRows } = await withRetry(
        () =>
          db.query<{
            id_cuenta: number;
            nombre_cuenta: string | null;
            locationid: string | null;
            token_ghl: string | null;
          }>(
            `SELECT id_cuenta, nombre_cuenta, locationid, token_ghl
             FROM cuentas WHERE id_cuenta = $1 LIMIT 1`,
            [oauthRows[0].id_cuenta],
          ),
        { label: "getAccountByLocationIdFallback/oauthLinkedCuenta" },
      );
      if (cuentaRows[0]) return cuentaRows[0];
    }
    // Token OAuth existe pero sin cuenta linkeada — retornar null (se guardará como huérfano)
    return null;
  }

  return null;
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

/**
 * Persiste el payload crudo en chat_webhook_raw para diagnóstico.
 * Guarda SIEMPRE — antes de cualquier filtro — para ver todo lo que llega.
 * Si falla el insert de debug, no bloquea el procesamiento principal.
 */
async function saveRawWebhook(
  body: ChatWebhookBody,
  locationId: string,
  processed: boolean,
  skipReason: string | null,
): Promise<void> {
  try {
    const contentType = (body.contentType ?? "") as string;
    const msgTypeNum = typeof (body as any).message?.type === "number"
      ? (body as any).message.type as number
      : null;
    const channelStr = body.messageType ?? (body as any).message?.messageType ?? null;
    const hasAtt = body.attachments !== undefined &&
      body.attachments !== null &&
      !(Array.isArray(body.attachments) && (body.attachments as unknown[]).length === 0);

    await db.query(
      `INSERT INTO chat_webhook_raw
         (location_id, event_type, direction, channel_type_number, channel_type_string,
          content_type, status, has_attachments, processed, skip_reason, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        locationId,
        body.type ?? null,
        body.direction ?? (body as any).message?.direction ?? null,
        msgTypeNum,
        channelStr ?? null,
        contentType || null,
        body.status ?? null,
        hasAtt,
        processed,
        skipReason,
        body,
      ],
    );
  } catch (err) {
    // Debug: nunca bloquear el flujo principal
    console.warn("[Chat] Error guardando raw webhook:", err);
  }
}

export async function processChatWebhook(
  body: ChatWebhookBody,
  locationId: string,
): Promise<ServiceResult> {
  // ── Logging diagnóstico completo ─────────────────────────────────────────
  console.log("[Chat] ── Webhook recibido ──────────────────────────────────");
  console.log("[Chat] locationId        :", locationId);
  console.log("[Chat] type (evento)     :", body.type ?? "(undefined)");
  console.log("[Chat] direction         :", body.direction ?? (body as any).message?.direction ?? "(undefined)");
  console.log("[Chat] contentType       :", body.contentType ?? "(undefined)");
  console.log("[Chat] status            :", body.status ?? "(undefined)");
  console.log("[Chat] attachments       :", body.attachments !== undefined ? JSON.stringify(body.attachments) : "(no attachments)");
  console.log("[Chat] messageType       :", body.messageType ?? (body as any).message?.messageType ?? "(undefined)");
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
    void saveRawWebhook(body, locationId, false, `contentType:${contentType || "vacío"}`);
    return { success: true, data: { skipped: true, reason: "contentType" } };
  }
  // Mensajes outbound tienen status="sent", inbound="delivered"
  // CALL/completed son eventos de llamada, no mensajes de chat → ignorar
  const isCallEvent = status === "completed" || (body as any).message?.type === "CALL" ||
    ((body as any).messageType ?? (body as any).message?.messageType) === "CALL";
  if (isCallEvent) {
    console.log(`[Chat] Ignorado — evento de llamada (CALL/completed)`);
    void saveRawWebhook(body, locationId, false, `call_event`);
    return { success: true, data: { skipped: true, reason: "call_event" } };
  }
  // Aceptar: delivered (inbound), sent (outbound), y vacío/undefined si hay direction
  const validStatus = status.includes("delivered") || status.includes("sent") ||
    (!status && (body.direction === "inbound" || body.direction === "outbound"));
  if (!validStatus) {
    console.log(`[Chat] Ignorado — status="${status}" (no es delivered/sent)`);
    void saveRawWebhook(body, locationId, false, `status:${status || "vacío"}`);
    return { success: true, data: { skipped: true, reason: "status" } };
  }
  if (hasAttachments) {
    console.log("[Chat] Ignorado — tiene attachments");
    void saveRawWebhook(body, locationId, false, "has_attachments");
    return { success: true, data: { skipped: true, reason: "attachments" } };
  }

  // ── 2. Filtro de tipo de evento ──────────────────────────────────────────
  const eventType = body.type;
  if (eventType && !PROCESSABLE_EVENT_TYPES.has(eventType)) {
    console.log(`[Chat] Ignorado — tipo de evento="${eventType}" (no es mensaje entrante/saliente)`);
    void saveRawWebhook(body, locationId, false, `eventType:${eventType}`);
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

  // ── 10. Upsert en chats_logs con deduplicación por _ghl_message_id ────────
  // GHL envía dos eventos por mensaje outbound: "sent" y "delivered".
  // Solo append si el messageId no existe ya en el array para evitar duplicados.
  const ghlMessageId = messageObj._ghl_message_id;

  await withRetry(
    () =>
      db.query(
        `INSERT INTO chats_logs
           (id_cuenta, nombre_lead, id_lead, chatid, fecha_y_hora_z, estado, notas_extra, chat, asesor_asignado)
         VALUES ($1, $2, $3, $4, NOW(), 'activo', $5, $6::jsonb, $8)
         ON CONFLICT (chatid) DO UPDATE SET
           -- Solo append si el messageId no está ya en el array (deduplicación)
           chat = CASE
             WHEN $7::text IS NOT NULL AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(chats_logs.chat) m
               WHERE m->>'_ghl_message_id' = $7::text
             ) THEN chats_logs.chat  -- ya existe, no duplicar
             ELSE chats_logs.chat || EXCLUDED.chat
           END,
           fecha_y_hora_z = NOW(),
           notas_extra    = COALESCE(EXCLUDED.notas_extra, chats_logs.notas_extra),
           nombre_lead    = EXCLUDED.nombre_lead,
           asesor_asignado = CASE
             WHEN EXCLUDED.asesor_asignado IS NOT NULL THEN EXCLUDED.asesor_asignado
             ELSE chats_logs.asesor_asignado
           END`,
        [
          idCuenta,
          contactName,
          contactId ?? null,
          conversationId,
          closerName ?? null,
          JSON.stringify([messageObj]),
          ghlMessageId ?? null,
          closerName ?? null,
        ],
      ),
    { label: "chat/upsertChatLog" },
  );

  console.log(`[Chat] ✅ Upsert OK — conversationId="${conversationId}" | id_cuenta=${idCuenta}`);

  // Guardar raw para diagnóstico (processed = true)
  void saveRawWebhook(body, locationId, true, null);

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

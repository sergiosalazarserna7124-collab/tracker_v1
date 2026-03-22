import { Type, type Static } from "@sinclair/typebox";

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const GhlChatMessage = Type.Object(
  {
    id: Type.Optional(Type.String()),
    direction: Type.Optional(Type.String()),   // "inbound" | "outbound"
    type: Type.Optional(Type.Number()),        // 1=SMS, 2=Email, 3=FB, 4=IG, 5=WA…
    messageType: Type.Optional(Type.String()), // string label del canal (usado por n8n)
    body: Type.Optional(Type.String()),
    dateAdded: Type.Optional(Type.String()),
    source: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    userId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    attachments: Type.Optional(Type.Unknown()),
    meta: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

const GhlChatContact = Type.Object(
  {
    id: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    firstName: Type.Optional(Type.String()),
    lastName: Type.Optional(Type.String()),
    fullNameLowerCase: Type.Optional(Type.String()),
    phone: Type.Optional(Type.String()),
    email: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

// ─── Body principal del webhook de conversaciones GHL ─────────────────────────

export const ChatWebhookBodySchema = Type.Object(
  {
    // Tipo de evento: "InboundMessage" | "OutboundMessage" | "ConversationUnreadUpdate" …
    type: Type.Optional(Type.String()),

    // Campos de filtro que replica la lógica n8n
    contentType: Type.Optional(Type.String()),  // "text/plain" esperado
    status: Type.Optional(Type.String()),        // "delivered" | "sent" …
    attachments: Type.Optional(Type.Unknown()),  // si existe → ignorar

    // Identificadores de la conversación
    locationId: Type.Optional(Type.String()),
    conversationId: Type.Optional(Type.String()),
    contactId: Type.Optional(Type.String()),

    // Objeto message (campos a nivel raíz del body en la app GHL marketplace)
    direction: Type.Optional(Type.String()),
    messageType: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
    dateAdded: Type.Optional(Type.String()),
    source: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    userId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    id: Type.Optional(Type.String()),           // messageId

    // Sub-objetos anidados (formato alternativo)
    message: Type.Optional(GhlChatMessage),
    contact: Type.Optional(GhlChatContact),
  },
  { additionalProperties: true },
);

export type ChatWebhookBody = Static<typeof ChatWebhookBodySchema>;

import { Type, type Static } from "@sinclair/typebox";

// Sólo los campos relevantes; additionalProperties: true absorbe el resto
// (GHL envía decenas de custom fields que no necesitamos procesar).

const TwilioLocation = Type.Object(
  {
    id: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const TwilioUser = Type.Object(
  {
    firstName: Type.Optional(Type.String()),
    lastName: Type.Optional(Type.String()),
    email: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const TwilioCustomData = Type.Object(
  {
    nombre: Type.Optional(Type.String()),
    email: Type.Optional(Type.String()),
    numero: Type.Optional(Type.String()),
    utm: Type.Optional(Type.String()),
    closermail: Type.Optional(Type.String()),
    nombrecloser: Type.Optional(Type.String()),
    // Presente en el evento no-answer; en el evento pdte viene en body.location.id
    locationid: Type.Optional(Type.String()),
    // ID del contacto en GHL (alternativa al email para identificar al lead)
    id_customer_ghl: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const TwilioBody = Type.Object(
  {
    contact_id: Type.Optional(Type.String()),
    first_name: Type.Optional(Type.String()),
    full_name: Type.Optional(Type.String()),
    phone: Type.Optional(Type.String()),
    location: Type.Optional(TwilioLocation),
    user: Type.Optional(TwilioUser),
    customData: TwilioCustomData,
  },
  { additionalProperties: true },
);

/**
 * El body del endpoint acepta dos formatos:
 *
 *   ① Directo desde GHL:  { contact_id, customData, ... }
 *   ② Envuelto por n8n:   [{ body: { contact_id, customData, ... }, headers, ... }]
 *
 * El controller usa extractWebhookBody() para normalizar antes de pasar al servicio.
 */
export const TwilioWebhookBody = Type.Union([
  // Formato directo
  TwilioBody,
  // Formato n8n
  Type.Array(
    Type.Object({ body: TwilioBody }, { additionalProperties: true }),
    { minItems: 1 },
  ),
]);

export type TwilioWebhookPayload = Static<typeof TwilioWebhookBody>;
export type TwilioEventBody = Static<typeof TwilioBody>;

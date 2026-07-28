import { Type, type Static } from "@sinclair/typebox";

/**
 * Schema para eventos de llamadas telefónicas de cuentas GHL.
 * Reutiliza la misma estructura de customData que Twilio (los workflows
 * de GHL ya lo envían así), más campos opcionales de contexto GHL.
 */

const GhlCallLocation = Type.Object(
  {
    id: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const GhlCallUser = Type.Object(
  {
    firstName: Type.Optional(Type.String()),
    lastName: Type.Optional(Type.String()),
    email: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const GhlCallCustomData = Type.Object(
  {
    nombre: Type.Optional(Type.String()),
    email: Type.Optional(Type.String()),
    numero: Type.Optional(Type.String()),
    utm: Type.Optional(Type.String()),
    closermail: Type.Optional(Type.String()),
    nombrecloser: Type.Optional(Type.String()),
    locationid: Type.Optional(Type.String()),
    idcuenta: Type.Optional(Type.String()),
    id_customer_ghl: Type.Optional(Type.String()),
    // Transcripción ya generada por GHL / Elto / proveedor externo
    transcript: Type.Optional(Type.String()),
    // Categoría de llamada enviada por el webhook (AUT-1863)
    // Acepta id o nombre de categoría; si se envía, se usa como autoritativa
    categoria: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const GhlCallBody = Type.Object(
  {
    contact_id: Type.Optional(Type.String()),
    first_name: Type.Optional(Type.String()),
    full_name: Type.Optional(Type.String()),
    phone: Type.Optional(Type.String()),
    locationid: Type.Optional(Type.String()),
    location: Type.Optional(GhlCallLocation),
    user: Type.Optional(GhlCallUser),
    customData: GhlCallCustomData,
  },
  { additionalProperties: true },
);

/**
 * El body acepta dos formatos:
 *   ① Directo desde GHL:  { contact_id, customData, ... }
 *   ② Envuelto por n8n:   [{ body: { ... }, headers, ... }]
 */
export const GhlCallWebhookBody = Type.Union([
  GhlCallBody,
  Type.Array(
    Type.Object({ body: GhlCallBody }, { additionalProperties: true }),
    { minItems: 1 },
  ),
]);

export type GhlCallWebhookPayload = Static<typeof GhlCallWebhookBody>;
export type GhlCallEventBody = Static<typeof GhlCallBody>;

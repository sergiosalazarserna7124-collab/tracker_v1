import { Type, type Static } from "@sinclair/typebox";

/**
 * Datos específicos del cliente/negocio que GHL adjunta en el workflow.
 * Son los campos que se guardan en resumenes_diarios_agendas.
 */
const GhlCustomData = Type.Object(
  {
    categoria: Type.String(),
    idcuenta: Type.String(),
    hora: Type.String(),
    zonahoraria: Type.String({ description: "Timezone IANA, ej: America/Bogota" }),
    nombre: Type.Optional(Type.String()),
    closer: Type.Optional(Type.String()),
    email: Type.Optional(Type.String()),
    origen: Type.Optional(Type.String()),
    idcliente: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/**
 * El objeto "body" que GHL genera y que n8n pasa como campo "body" del evento.
 */
const GhlBodyData = Type.Object(
  {
    first_name: Type.Optional(Type.String()),
    full_name: Type.Optional(Type.String()),
    email: Type.Optional(Type.String()),
    phone: Type.Optional(Type.String()),
    contact_id: Type.Optional(Type.String()),
    locationid: Type.Optional(Type.String()),
    customData: GhlCustomData,
  },
  { additionalProperties: true },
);

/**
 * n8n envuelve cada evento en un objeto con headers, body, params, query, etc.
 * El payload real de GHL está dentro del campo "body".
 */
const GhlEventItem = Type.Object(
  {
    body: GhlBodyData,
    headers: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    webhookUrl: Type.Optional(Type.String()),
    executionMode: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/**
 * n8n siempre envía un array de items, incluso cuando es un solo evento.
 */
export const GhlWebhookBody = Type.Array(GhlEventItem, { minItems: 1 });

export type GhlWebhookPayload = Static<typeof GhlWebhookBody>;
export type GhlBodyPayload = Static<typeof GhlBodyData>;
export type GhlCustomDataPayload = Static<typeof GhlCustomData>;

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
 * El cuerpo real del evento de GHL.
 * Se exporta como tipo para que el servicio lo use directamente.
 */
export const GhlBodyData = Type.Object(
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
 * El body del endpoint acepta dos formatos:
 *
 *   ① Directo desde GHL:  { contact_id, customData, ... }
 *   ② Envuelto por n8n:   [{ body: { contact_id, customData, ... }, headers, ... }]
 *
 * El controller usa extractWebhookBody() para normalizar antes de pasar al servicio.
 */
export const GhlWebhookBody = Type.Union([
  // Formato directo
  GhlBodyData,
  // Formato n8n
  Type.Array(
    Type.Object({ body: GhlBodyData }, { additionalProperties: true }),
    { minItems: 1 },
  ),
]);

export type GhlWebhookPayload = Static<typeof GhlWebhookBody>;
export type GhlBodyPayload = Static<typeof GhlBodyData>;
export type GhlCustomDataPayload = Static<typeof GhlCustomData>;

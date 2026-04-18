import { Type, type Static } from "@sinclair/typebox";

const ReasignacionCustomData = Type.Object(
  {
    idusuario: Type.String(),
    locationid: Type.String(),
    correocloser: Type.Optional(Type.String()),
    nombrecloser: Type.Optional(Type.String()),
    nombre: Type.Optional(Type.String()),
    telefono: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const ReasignacionBodyData = Type.Object(
  {
    customData: ReasignacionCustomData,
    phone: Type.Optional(Type.String()),
    full_name: Type.Optional(Type.String()),
    first_name: Type.Optional(Type.String()),
    location: Type.Optional(
      Type.Object({ id: Type.Optional(Type.String()) }, { additionalProperties: true }),
    ),
  },
  { additionalProperties: true },
);

export const ReasignacionWebhookBody = Type.Union([
  ReasignacionBodyData,
  Type.Array(
    Type.Object({ body: ReasignacionBodyData }, { additionalProperties: true }),
    { minItems: 1 },
  ),
]);

export type ReasignacionWebhookPayload = Static<typeof ReasignacionWebhookBody>;
export type ReasignacionBodyPayload = Static<typeof ReasignacionBodyData>;

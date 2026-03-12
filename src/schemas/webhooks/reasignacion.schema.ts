import { Type, type Static } from "@sinclair/typebox";

const ReasignacionCustomData = Type.Object(
  {
    idusuario: Type.String(),
    correocloser: Type.String(),
    nombrecloser: Type.String(),
    locationid: Type.String(),
  },
  { additionalProperties: true },
);

export const ReasignacionBodyData = Type.Object(
  {
    customData: ReasignacionCustomData,
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

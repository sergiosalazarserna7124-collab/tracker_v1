import { Type, type Static } from "@sinclair/typebox";

export const AsistenciaParams = Type.Object({
  id_cuenta: Type.String({ minLength: 1 }),
});

export type AsistenciaParamsType = Static<typeof AsistenciaParams>;

export const AsistenciaEventBodySchema = Type.Object({
  tipo: Type.Union([Type.Literal("asistio"), Type.Literal("no_show")]),
  email_lead: Type.Optional(Type.String({ format: "email" })),
  ghl_contact_id: Type.Optional(Type.String({ minLength: 1 })),
  fecha_reunion: Type.Optional(Type.String()),
});

export const AsistenciaWebhookBody = Type.Union([
  AsistenciaEventBodySchema,
  Type.Array(
    Type.Object(
      { body: Type.Optional(AsistenciaEventBodySchema) },
      { additionalProperties: true },
    ),
    { minItems: 1 },
  ),
]);

export type AsistenciaWebhookPayload = Static<typeof AsistenciaWebhookBody>;
export type AsistenciaEventBody = Static<typeof AsistenciaEventBodySchema>;

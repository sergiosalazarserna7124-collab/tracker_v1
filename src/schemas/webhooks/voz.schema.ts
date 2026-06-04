import { Type, type Static } from "@sinclair/typebox";

const VozEstado = Type.Union([
  Type.Literal("interesado"),
  Type.Literal("no_interesado"),
  Type.Literal("no_elegible"),
  Type.Literal("reagendado"),
  Type.Literal("no_contesto"),
  Type.Literal("buzon_voz"),
  Type.Literal("colgo_temprano"),
  Type.Literal("error"),
  Type.Literal("desconocido"),
]);

export const VozCallCompletedBody = Type.Object(
  {
    event: Type.String(),
    call_id: Type.String(),
    accountid: Type.Union([Type.String(), Type.Number()]),
    estado: VozEstado,
    phone: Type.Optional(Type.String()),
    client_email: Type.Optional(Type.String()),
    client_whatsapp: Type.Optional(Type.String()),
    broker_name: Type.Optional(Type.String()),
    userid: Type.Optional(Type.String()),
    transcript: Type.Optional(Type.String()),
    short_summary: Type.Optional(Type.String()),
    duration_seconds: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

export type VozCallCompletedPayload = Static<typeof VozCallCompletedBody>;

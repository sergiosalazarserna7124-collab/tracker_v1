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
  Type.Literal("agendado"),
  Type.Literal("confirmado"),
]);

const VozReagendamiento = Type.Object(
  {
    scheduled_for: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    timezone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    when_text: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    modo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
);

// ya_afiliado: respuestas textuales del prospecto cuando dice que ya está
// afiliado a otra red. Independiente del estado.
const VozYaAfiliado = Type.Object(
  {
    con_quien: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    como_le_va: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
);

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
    broker_company: Type.Optional(Type.String()),
    campaign_id: Type.Optional(Type.String()),
    // contactid = id del contacto en GHL (v2; alias legado: userid)
    contactid: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    userid: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    reagendamiento: Type.Optional(Type.Union([VozReagendamiento, Type.Null()])),
    // etiquetas: tags genéricos a aplicar al contacto, independientes del estado
    // (hoy solo "afiliado_imexico", pero el array es extensible).
    etiquetas: Type.Optional(Type.Array(Type.String())),
    ya_afiliado: Type.Optional(Type.Union([VozYaAfiliado, Type.Null()])),
    agentid: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    transcript: Type.Optional(Type.String()),
    short_summary: Type.Optional(Type.String()),
    ended_at: Type.Optional(Type.String()),
    duration_seconds: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

export type VozCallCompletedPayload = Static<typeof VozCallCompletedBody>;

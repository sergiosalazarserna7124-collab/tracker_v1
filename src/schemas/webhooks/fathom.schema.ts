import { Type, type Static } from "@sinclair/typebox";

// ─── Params ───────────────────────────────────────────────────────────────────

export const FathomParams = Type.Object({
  id_cuenta: Type.String({ minLength: 1 }),
});

export type FathomParamsType = Static<typeof FathomParams>;

// ─── Tipos internos del body ──────────────────────────────────────────────────

const FathomSpeaker = Type.Object(
  {
    display_name: Type.Optional(Type.String()),
    matched_calendar_invitee_email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
);

const FathomTranscriptItem = Type.Object(
  {
    speaker: FathomSpeaker,
    text: Type.String(),
    timestamp: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const FathomCalendarInvitee = Type.Object(
  {
    email: Type.String(),
    is_external: Type.Boolean(),
    name: Type.Optional(Type.String()),
    matched_speaker_display_name: Type.Optional(Type.String()),
    email_domain: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const FathomRecordedBy = Type.Object(
  {
    email: Type.String(),
    name: Type.String(),
    email_domain: Type.Optional(Type.String()),
    team: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

// ─── Cuerpo real del evento Fathom ────────────────────────────────────────────

export const FathomEventBodySchema = Type.Object(
  {
    recording_id: Type.Optional(Type.Number()),
    share_url: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    meeting_title: Type.Optional(Type.String()),
    created_at: Type.Optional(Type.String()),
    scheduled_start_time: Type.Optional(Type.String()),
    scheduled_end_time: Type.Optional(Type.String()),
    recording_start_time: Type.Optional(Type.String()),
    recording_end_time: Type.Optional(Type.String()),
    recorded_by: Type.Optional(FathomRecordedBy),
    calendar_invitees: Type.Optional(Type.Array(FathomCalendarInvitee)),
    transcript: Type.Optional(Type.Array(FathomTranscriptItem)),
  },
  { additionalProperties: true },
);

/**
 * El body del endpoint acepta dos formatos:
 *
 *   ① Directo desde Fathom: { recording_id, share_url, transcript, ... }
 *   ② Envuelto por n8n:     [{ body: { recording_id, ... }, headers, ... }]
 *
 * El controller usa extractWebhookBody() para normalizar antes de pasar al servicio.
 */
export const FathomWebhookBody = Type.Union([
  // Formato directo
  FathomEventBodySchema,
  // Formato n8n
  Type.Array(
    Type.Object(
      { body: Type.Optional(FathomEventBodySchema) },
      { additionalProperties: true },
    ),
    { minItems: 1 },
  ),
]);

export type FathomWebhookPayload = Static<typeof FathomWebhookBody>;
export type FathomEventBody = Static<typeof FathomEventBodySchema>;

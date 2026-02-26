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

// ─── Body del webhook Fathom ──────────────────────────────────────────────────
// El payload llega envuelto en el array de n8n: [{ body: { ... } }]
// El controller desenvuelve el array y pasa solo el `body` interno al servicio.

export const FathomWebhookBody = Type.Array(
  Type.Object(
    {
      body: Type.Optional(
        Type.Object(
          {
            recording_id: Type.Optional(Type.Number()),
            share_url: Type.Optional(Type.String()),
            url: Type.Optional(Type.String()),
            title: Type.Optional(Type.String()),
            meeting_title: Type.Optional(Type.String()),
            created_at: Type.Optional(Type.String()),
            recording_start_time: Type.Optional(Type.String()),
            recording_end_time: Type.Optional(Type.String()),
            recorded_by: Type.Optional(FathomRecordedBy),
            calendar_invitees: Type.Optional(Type.Array(FathomCalendarInvitee)),
            transcript: Type.Optional(Type.Array(FathomTranscriptItem)),
          },
          { additionalProperties: true },
        ),
      ),
    },
    { additionalProperties: true },
  ),
  { minItems: 1 },
);

export type FathomWebhookPayload = Static<typeof FathomWebhookBody>;

// Tipo del body interno (un evento Fathom ya desenvuelto)
export type FathomEventBody = NonNullable<FathomWebhookPayload[number]["body"]>;

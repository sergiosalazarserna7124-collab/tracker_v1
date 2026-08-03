import { Type, type Static } from "@sinclair/typebox";

const FathomCalendarInvitee = Type.Object(
  {
    email: Type.String(),
    is_external: Type.Boolean(),
    name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    matched_speaker_display_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    email_domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
);

const FathomRecordedBy = Type.Object(
  {
    email: Type.String(),
    name: Type.String(),
    email_domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    team: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
);

const MeetingSnapshot = Type.Object(
  {
    recording_id: Type.Number(),
    title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    meeting_title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    share_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    created_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    scheduled_start_time: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    scheduled_end_time: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    recording_start_time: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    recording_end_time: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    transcript_language: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    recorded_by: Type.Optional(Type.Union([FathomRecordedBy, Type.Null()])),
    calendar_invitees: Type.Optional(Type.Array(FathomCalendarInvitee)),
  },
  { additionalProperties: true },
);

export const VideoRecoveryPreviewBody = Type.Object({
  id_evento: Type.String({ minLength: 1 }),
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
  timezone: Type.String({ minLength: 1 }),
  // Arrays vacíos = "sin filtro" (el front puede enviar [] u omitir la clave).
  teams: Type.Optional(Type.Array(Type.String())),
  recorded_by: Type.Optional(Type.Array(Type.String())),
  calendar_invitees_domains: Type.Optional(Type.Array(Type.String())),
  calendar_invitees_domains_type: Type.Optional(
    Type.Union([
      Type.Literal("all"),
      Type.Literal("only_internal"),
      Type.Literal("one_or_more_external"),
    ]),
  ),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
});

export type VideoRecoveryPreviewBodyType = Static<typeof VideoRecoveryPreviewBody>;

const SelectedRecording = Type.Object({
  recording_id: Type.Number(),
  id_registro_agenda: Type.Optional(Type.Number()),
  action: Type.Union([
    Type.Literal("recover_existing"),
    Type.Literal("create_if_missing"),
    Type.Literal("skip"),
  ]),
  meeting_snapshot: MeetingSnapshot,
});

export const VideoRecoveryExecuteBody = Type.Object({
  id_evento: Type.String({ minLength: 1 }),
  request_id: Type.String({ minLength: 1 }),
  selected_recordings: Type.Array(SelectedRecording, { minItems: 1, maxItems: 20 }),
});

export type VideoRecoveryExecuteBodyType = Static<typeof VideoRecoveryExecuteBody>;

export type MeetingSnapshotType = Static<typeof MeetingSnapshot>;

export const VideoRecoveryRelinkBody = Type.Object({
  id_evento: Type.String({ minLength: 1 }),
  recording_id: Type.Number(),
  id_registro_agenda: Type.Number(),
  meeting_snapshot: MeetingSnapshot,
});

export type VideoRecoveryRelinkBodyType = Static<typeof VideoRecoveryRelinkBody>;

export const VideoRecoveryAgendaSearchBody = Type.Object({
  q: Type.Optional(Type.String()),
  fecha_from: Type.Optional(Type.String()),
  fecha_to: Type.Optional(Type.String()),
  categoria: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
});

export type VideoRecoveryAgendaSearchBodyType = Static<typeof VideoRecoveryAgendaSearchBody>;

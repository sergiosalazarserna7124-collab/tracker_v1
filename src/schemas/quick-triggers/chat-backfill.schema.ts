import { Type, type Static } from "@sinclair/typebox";

export const ChatBackfillBody = Type.Object({
  since_date: Type.String({ format: "date", description: "Backfill conversations with activity since this date (YYYY-MM-DD)" }),
  max_conversations: Type.Optional(Type.Number({ minimum: 1, maximum: 2000, default: 500 })),
  dry_run: Type.Optional(Type.Boolean({ default: false })),
});

export type ChatBackfillBodyType = Static<typeof ChatBackfillBody>;

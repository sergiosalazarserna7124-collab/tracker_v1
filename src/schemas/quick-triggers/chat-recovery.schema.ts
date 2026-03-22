import { Type, type Static } from "@sinclair/typebox";

export const ChatRecoveryPreviewBody = Type.Object({
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  channel_filter: Type.Optional(Type.String()), // WhatsApp, FB, IG, etc. o "all"
});

export type ChatRecoveryPreviewBodyType = Static<typeof ChatRecoveryPreviewBody>;

const SelectedConversation = Type.Object({
  conversationId: Type.String({ minLength: 1 }),
  contactId: Type.String({ minLength: 1 }),
  contactName: Type.String(),
});

export const ChatRecoveryExecuteBody = Type.Object({
  selected_conversations: Type.Array(SelectedConversation, { minItems: 1, maxItems: 50 }),
});

export type ChatRecoveryExecuteBodyType = Static<typeof ChatRecoveryExecuteBody>;

export type SelectedConversationType = Static<typeof SelectedConversation>;

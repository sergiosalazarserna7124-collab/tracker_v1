-- AUT-1531: índice parcial para la reconciliación de remoción del tag sin_responder_chat.
-- El cron de reconciliación busca chats etiquetados y aún no removidos
-- (chat_sin_responder_tagged_at IS NOT NULL AND chat_sin_responder_removed_at IS NULL).
-- El índice parcial existente (idx_chats_sin_responder_pending) solo cubre el path de
-- ETIQUETADO (tagged_at IS NULL), no el de remoción. Este cubre el subconjunto pequeño
-- de tags pendientes de reconciliar → evita seq scan de chats_logs en cada corrida.
-- chats_logs ~85k filas → build sub-segundo, dentro del statement_timeout de 30s del runner.
CREATE INDEX IF NOT EXISTS idx_chats_sin_responder_tagged_pending
  ON public.chats_logs (id_cuenta, chatid)
  WHERE chat_sin_responder_tagged_at IS NOT NULL
    AND chat_sin_responder_removed_at IS NULL;

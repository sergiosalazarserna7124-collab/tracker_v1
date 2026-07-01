-- AUT-1160: Auto-tag sin_responder_chat
-- Columns on chats_logs to track tag lifecycle + config in metas_cuenta

ALTER TABLE chats_logs
  ADD COLUMN IF NOT EXISTS chat_sin_responder_tagged_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS chat_sin_responder_removed_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_chats_sin_responder_pending
  ON chats_logs (id_cuenta, primer_msg_lead_at)
  WHERE chat_sin_responder_tagged_at IS NULL
    AND primer_msg_lead_at IS NOT NULL;

ALTER TABLE metas_cuenta
  ADD COLUMN IF NOT EXISTS meta_tag_sin_responder_wait_min INTEGER;

-- Activate for cuenta 36 (floralia) — 15 min default
UPDATE metas_cuenta
  SET meta_tag_sin_responder_wait_min = 15
  WHERE id_cuenta = 36
    AND meta_tag_sin_responder_wait_min IS NULL;

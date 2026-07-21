-- AUT-1706: batch analysis now uses primer_msg_at (immutable) instead of
-- fecha_y_hora_z (mutable). Create a matching partial index and drop the old one.
CREATE INDEX IF NOT EXISTS idx_chats_batch_primer_msg_at
  ON chats_logs (id_cuenta, primer_msg_at DESC)
  WHERE ia_objeciones IS NULL;

DROP INDEX IF EXISTS idx_chats_logs_batch_pending;

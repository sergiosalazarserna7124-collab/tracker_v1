-- Índice parcial para el cron batch-analizar-conversaciones (AUT-391)
-- Acelera la query: ia_objeciones IS NULL AND fecha_y_hora_z >= NOW() - INTERVAL '48 hours'
-- CONCURRENTLY: no bloquea lecturas/escrituras durante la creación

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chats_logs_batch_pending
  ON chats_logs (id_cuenta, fecha_y_hora_z DESC)
  WHERE ia_objeciones IS NULL;

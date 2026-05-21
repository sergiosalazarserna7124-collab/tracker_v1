-- AUT-317: Speed-to-lead chat alerts
-- Columnas para trackear cuándo se enviaron alertas automáticas cuando un chat
-- lleva demasiado tiempo sin respuesta de agente.
-- ADD COLUMN nullable es DDL instantáneo en PostgreSQL (sin lock de tabla).

ALTER TABLE chats_logs
  ADD COLUMN IF NOT EXISTS chat_stl_alerted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS chat_stl_4h_alerted_at TIMESTAMPTZ;

-- Índice parcial para acelerar la consulta del cron de alerta 60m
-- (chats con primer mensaje del lead sin alerta previa)
CREATE INDEX IF NOT EXISTS idx_chats_stl_pending_60m
  ON chats_logs(id_cuenta, primer_msg_lead_at)
  WHERE primer_msg_lead_at IS NOT NULL
    AND chat_stl_alerted_at IS NULL;

-- Índice parcial para acelerar la consulta del cron de escalación 4h
-- (chats que ya recibieron alerta 60m pero aún no fueron escalados)
CREATE INDEX IF NOT EXISTS idx_chats_stl_pending_4h
  ON chats_logs(id_cuenta, primer_msg_lead_at)
  WHERE primer_msg_lead_at IS NOT NULL
    AND chat_stl_alerted_at IS NOT NULL
    AND chat_stl_4h_alerted_at IS NULL;

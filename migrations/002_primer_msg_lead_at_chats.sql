-- Migración 002: Agregar columna primer_msg_lead_at en chats_logs
-- Propósito: Corregir cálculo de speed-to-lead para chats (AUT-143)
--
-- El problema: fecha_y_hora_z se actualiza en cada upsert (NOW()),
-- por lo que filtrar la ventana de 7 días por esa columna incluye
-- conversaciones históricas que recibieron mensajes nuevos o re-syncs.
--
-- La solución: almacenar el timestamp del primer mensaje del lead
-- (primer mensaje inbound) inmutable desde el primer insert.

-- 1. Agregar columna (nullable — se rellena al procesar mensajes nuevos)
ALTER TABLE chats_logs
  ADD COLUMN IF NOT EXISTS primer_msg_lead_at TIMESTAMPTZ;

-- 2. Backfill para conversaciones existentes:
--    extraer el mínimo timestamp de los mensajes con role='lead' del JSONB
UPDATE chats_logs
SET primer_msg_lead_at = (
  SELECT MIN((msg->>'timestamp')::timestamptz)
  FROM jsonb_array_elements(chat) AS msg
  WHERE msg->>'role' = 'lead'
    AND msg->>'timestamp' IS NOT NULL
    AND (msg->>'timestamp') <> ''
)
WHERE primer_msg_lead_at IS NULL
  AND chat IS NOT NULL
  AND jsonb_array_length(chat) > 0;

-- 3. Índice para acelerar el filtro de ventana 7d en el dashboard
CREATE INDEX IF NOT EXISTS idx_chats_logs_primer_msg_lead_at
  ON chats_logs (id_cuenta, primer_msg_lead_at);

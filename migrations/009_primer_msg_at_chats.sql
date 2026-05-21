-- Migración 009: Agregar columna primer_msg_at en chats_logs (AUT-316)
--
-- Problema: primer_msg_lead_at solo se establece cuando el lead envía el primer
-- mensaje (dirección inbound). Las conversaciones iniciadas por el agente
-- (outbound) quedan con primer_msg_lead_at = NULL, haciéndolas invisibles
-- en el dashboard cuando se aplica un filtro de fecha.
-- Esto afecta el 45–73% de los chats en varios tenants.
--
-- Solución: introducir primer_msg_at = timestamp del primer mensaje de la
-- conversación, sin importar la dirección (inbound o outbound). Se establece
-- en el INSERT y nunca se actualiza (inmutable como primer_msg_lead_at).
--
-- Uso:
--   primer_msg_at     → filtro de fecha en el dashboard (qué chats mostrar)
--   primer_msg_lead_at → cálculo de STL CHAT (tiempo hasta respuesta del lead)

-- 1. Agregar columna (nullable — se rellena con backfill abajo)
ALTER TABLE chats_logs
  ADD COLUMN IF NOT EXISTS primer_msg_at TIMESTAMPTZ;

-- 2. Backfill desde el timestamp mínimo del JSONB chat (cualquier role)
UPDATE chats_logs
SET primer_msg_at = (
  SELECT MIN((msg->>'timestamp')::timestamptz)
  FROM jsonb_array_elements(chat) AS msg
  WHERE msg->>'timestamp' IS NOT NULL
    AND (msg->>'timestamp') <> ''
    AND (msg->>'timestamp')::timestamptz > '2020-01-01'::timestamptz
)
WHERE chat IS NOT NULL
  AND jsonb_array_length(chat) > 0
  AND primer_msg_at IS NULL;

-- 3. Fallback: para chats sin timestamps válidos en JSONB, usar primer_msg_lead_at
--    o fecha_y_hora_z como aproximación
UPDATE chats_logs
SET primer_msg_at = COALESCE(primer_msg_lead_at, fecha_y_hora_z)
WHERE primer_msg_at IS NULL;

-- 4. Índice para acelerar el filtro de ventana temporal en el dashboard
CREATE INDEX IF NOT EXISTS idx_chats_logs_primer_msg_at
  ON chats_logs (id_cuenta, primer_msg_at);

-- Verificación post-migración (ejecutar manualmente):
-- SELECT id_cuenta, COUNT(*) total,
--        COUNT(primer_msg_at) con_primer_msg_at,
--        COUNT(*) - COUNT(primer_msg_at) sin_primer_msg_at
-- FROM chats_logs
-- GROUP BY id_cuenta
-- ORDER BY total DESC;

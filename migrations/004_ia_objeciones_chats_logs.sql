-- Migración 004: Añadir columna ia_objeciones a chats_logs
-- Parte de AUT-193: soporte para objeciones de venta detectadas por AI

ALTER TABLE chats_logs
  ADD COLUMN IF NOT EXISTS ia_objeciones jsonb;

-- Índice parcial para búsquedas de chats con objeciones detectadas
CREATE INDEX IF NOT EXISTS idx_chats_logs_ia_objeciones
  ON chats_logs USING gin (ia_objeciones)
  WHERE ia_objeciones IS NOT NULL;

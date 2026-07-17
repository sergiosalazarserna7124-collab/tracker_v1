-- AUT-1628: Agregar columna ia_objeciones a registros_de_llamada y log_llamadas
-- para persistir objeciones extraídas por IA en llamadas telefónicas (Twilio/GHL).
-- Idempotente: IF NOT EXISTS.

ALTER TABLE registros_de_llamada
  ADD COLUMN IF NOT EXISTS ia_objeciones JSONB;

ALTER TABLE log_llamadas
  ADD COLUMN IF NOT EXISTS ia_objeciones JSONB;

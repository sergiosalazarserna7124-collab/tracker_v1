-- AUT-1804: Cortar loop de re-facturación del backfill de Gemini
-- Agrega columna gemini_intentos para rastrear intentos fallidos y excluirlos
-- del set de candidatos después de N intentos (evita re-procesamiento infinito).

ALTER TABLE log_llamadas ADD COLUMN IF NOT EXISTS gemini_intentos SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE resumenes_diarios_agendas ADD COLUMN IF NOT EXISTS gemini_intentos SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE chats_logs ADD COLUMN IF NOT EXISTS gemini_intentos SMALLINT NOT NULL DEFAULT 0;

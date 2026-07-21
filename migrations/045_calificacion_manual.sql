-- AUT-1705: calificación/descarte self-service vía webhook (label-agnostic)
-- Agrega columna calificacion_manual para override del cliente sobre la IA.
-- Valores posibles: 'calificado', 'descartado', NULL (IA decide).

ALTER TABLE chats_logs
  ADD COLUMN IF NOT EXISTS calificacion_manual TEXT DEFAULT NULL;

ALTER TABLE registros_de_llamada
  ADD COLUMN IF NOT EXISTS calificacion_manual TEXT DEFAULT NULL;

ALTER TABLE log_llamadas
  ADD COLUMN IF NOT EXISTS calificacion_manual TEXT DEFAULT NULL;

-- Índice parcial para filtrar leads con override manual (consultas de métricas)
CREATE INDEX IF NOT EXISTS idx_chats_calificacion_manual
  ON chats_logs (id_cuenta, calificacion_manual)
  WHERE calificacion_manual IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_llamadas_calificacion_manual
  ON registros_de_llamada (id_cuenta, calificacion_manual)
  WHERE calificacion_manual IS NOT NULL;

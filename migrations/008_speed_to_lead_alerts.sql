-- AUT-221: Speed-to-lead alerts
-- Columnas para trackear cuándo se enviaron alertas automáticas al asesor y manager
-- cuando un lead lleva demasiado tiempo sin primer contacto.

ALTER TABLE registros_de_llamada
  ADD COLUMN IF NOT EXISTS speed_to_lead_alerted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS speed_to_lead_4h_alerted_at TIMESTAMPTZ;

-- Índice parcial para acelerar la consulta del cron de alerta 60m (leads sin alerta previa)
CREATE INDEX IF NOT EXISTS idx_rdl_speed_alert_pending
  ON registros_de_llamada(id_cuenta, fecha_evento)
  WHERE fecha_primera_llamada IS NULL
    AND intentos_contacto = 0
    AND speed_to_lead_alerted_at IS NULL;

-- Índice parcial para acelerar la consulta del cron de escalación 4h
-- (leads que ya recibieron alerta 60m pero aún no han sido escalados)
CREATE INDEX IF NOT EXISTS idx_rdl_speed_4h_pending
  ON registros_de_llamada(id_cuenta, fecha_evento)
  WHERE fecha_primera_llamada IS NULL
    AND intentos_contacto = 0
    AND speed_to_lead_alerted_at IS NOT NULL
    AND speed_to_lead_4h_alerted_at IS NULL;

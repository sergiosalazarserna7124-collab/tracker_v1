-- Tracking de citas vía GHL Marketplace (AppointmentCreate/Update/Delete).
-- ghl_appointment_id: id de la cita en GHL → permite actualizar la cita correcta
--   y detectar reagendas (cambio de startTime).
-- estado_cita: estado de AGENDAMIENTO (confirmada/cancelada/reagendada/no_show/
--   asistida), separado de `categoria` (resultado de la reunión, que setea Fathom
--   y el flujo de asistencia sobre 'PDTE').

ALTER TABLE resumenes_diarios_agendas
  ADD COLUMN IF NOT EXISTS ghl_appointment_id TEXT,
  ADD COLUMN IF NOT EXISTS estado_cita        TEXT;

CREATE INDEX IF NOT EXISTS idx_agendas_cuenta_appt
  ON resumenes_diarios_agendas (id_cuenta, ghl_appointment_id)
  WHERE ghl_appointment_id IS NOT NULL;

-- AUT-1061: Razones de pérdida — config y data en tabla cuentas
-- Ambas columnas JSONB nullable. razones_perdida_config guarda las opciones disponibles
-- por tenant; razones_perdida_data guarda cada evento de pérdida registrado.

ALTER TABLE cuentas
  ADD COLUMN IF NOT EXISTS razones_perdida_config jsonb,
  ADD COLUMN IF NOT EXISTS razones_perdida_data jsonb;

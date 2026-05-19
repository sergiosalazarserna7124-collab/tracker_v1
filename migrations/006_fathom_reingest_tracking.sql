-- AUT-270: Tracking de re-ingestas de Fathom
-- Columnas nuevas en resumenes_diarios_agendas para registrar cuándo Fathom
-- corrigió la categoría de un registro existente y cuál era la anterior.
ALTER TABLE resumenes_diarios_agendas
  ADD COLUMN IF NOT EXISTS fathom_reingest_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS categoria_previa VARCHAR;

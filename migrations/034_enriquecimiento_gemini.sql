-- AUT-1301: enriquecimiento Gemini + duración + ubicación por lada
-- Aplica a: registros_de_llamada, log_llamadas, resumenes_diarios_agendas, chats_logs

-- registros_de_llamada (estado actual del lead)
ALTER TABLE registros_de_llamada ADD COLUMN IF NOT EXISTS gemini_enriquecimiento jsonb;
ALTER TABLE registros_de_llamada ADD COLUMN IF NOT EXISTS duracion_segundos integer;
ALTER TABLE registros_de_llamada ADD COLUMN IF NOT EXISTS ubicacion_aprox text;

-- log_llamadas (historial inmutable)
ALTER TABLE log_llamadas ADD COLUMN IF NOT EXISTS gemini_enriquecimiento jsonb;
ALTER TABLE log_llamadas ADD COLUMN IF NOT EXISTS duracion_segundos integer;
ALTER TABLE log_llamadas ADD COLUMN IF NOT EXISTS ubicacion_aprox text;

-- resumenes_diarios_agendas (videollamadas Fathom)
ALTER TABLE resumenes_diarios_agendas ADD COLUMN IF NOT EXISTS gemini_enriquecimiento jsonb;
ALTER TABLE resumenes_diarios_agendas ADD COLUMN IF NOT EXISTS duracion_segundos integer;
ALTER TABLE resumenes_diarios_agendas ADD COLUMN IF NOT EXISTS ubicacion_aprox text;

-- chats_logs (no está en Drizzle schema, acceso por raw SQL)
ALTER TABLE chats_logs ADD COLUMN IF NOT EXISTS gemini_enriquecimiento jsonb;
ALTER TABLE chats_logs ADD COLUMN IF NOT EXISTS ubicacion_aprox text;

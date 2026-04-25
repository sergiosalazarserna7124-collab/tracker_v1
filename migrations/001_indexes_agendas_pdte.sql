-- Migración: índices parciales en resumenes_diarios_agendas para lookups PDTE
-- Fecha: 2026-04-25
-- Contexto: effectivePath() en el Cerebro filtra esta tabla por ghl_contact_id
--           y email_lead cuando categoria = 'PDTE'. Sin índices, cada lookup
--           hace seq scan en ~5,481 filas (crecerá con cada cliente nuevo).
--
-- REQUIERE: usuario con permisos DDL (superuser o el owner de la tabla).
-- EJECUTAR CON APROBACIÓN DE JUAN antes de correr en producción.
--
-- Estimado: CREATE INDEX CONCURRENTLY es non-blocking en prod; las versiones
--           sin CONCURRENTLY bloquean escrituras. En tabla de ~5k filas el
--           lock es de milisegundos, pero se documenta por buena práctica.

-- Índice principal: lookup por contacto GHL (caso más frecuente)
CREATE INDEX IF NOT EXISTS idx_agendas_cuenta_contact_pdte
  ON resumenes_diarios_agendas(id_cuenta, ghl_contact_id)
  WHERE categoria = 'PDTE';

-- Índice fallback: lookup por email (case-insensitive)
CREATE INDEX IF NOT EXISTS idx_agendas_cuenta_email_pdte
  ON resumenes_diarios_agendas(id_cuenta, LOWER(email_lead))
  WHERE categoria = 'PDTE';

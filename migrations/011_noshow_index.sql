-- Migración: índice parcial en resumenes_diarios_agendas para lookup no_show
-- Fecha: 2026-05-21
-- Contexto: handlePendiente en ghl.service.ts busca el no_show más reciente
--           por (id_cuenta, ghl_contact_id) WHERE categoria = 'no_show'.
--           Sin este índice, cada reagendamiento hace seq scan en toda la tabla.
--
-- REQUIERE: usuario con permisos DDL (superuser o el owner de la tabla).
-- EJECUTAR CON APROBACIÓN DE JUAN antes de correr en producción.
--
-- IMPORTANTE: CREATE INDEX CONCURRENTLY no puede correr dentro de una transacción.
-- Ejecutar cada sentencia por separado si se usa dentro de un bloque BEGIN/COMMIT.
-- En psql directo (sin transaction wrapper) se puede ejecutar el archivo tal cual.
--
-- CONCURRENTLY: non-blocking en producción — no bloquea escrituras durante la creación.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agendas_cuenta_contact_noshow
  ON resumenes_diarios_agendas(id_cuenta, ghl_contact_id)
  WHERE categoria = 'no_show';

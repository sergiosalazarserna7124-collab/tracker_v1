-- AUT-779: Merge histórico de leads duplicados pre-fix #79
-- Aprobado por Juan Diaz (board) 2026-06-09
--
-- Criterios de fusión:
--   - Mismo id_cuenta + ghl_contact_id con >1 fila
--   - Ventana temporal < 30 días entre registros del grupo
--   - Ningún registro del grupo en estado terminal (venta/ganado/ganada/perdido/perdida/cerrado/cerrada)
--
-- Lógica:
--   - Superviviente = registro más reciente (por fecha_evento) del grupo
--   - Re-apuntar log_llamadas.id_registro de los sobrantes al superviviente
--   - Sumar intentos_contacto al superviviente
--   - Elegir el "mejor" estado (calificada > seguimiento > otros)
--   - Eliminar registros sobrantes

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PASO 1: Backup
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS _backup_779_registros_de_llamada AS
  SELECT * FROM registros_de_llamada WHERE false;

CREATE TABLE IF NOT EXISTS _backup_779_log_llamadas AS
  SELECT * FROM log_llamadas WHERE false;

TRUNCATE _backup_779_registros_de_llamada;
TRUNCATE _backup_779_log_llamadas;

-- Backup only affected records
WITH dup_groups AS (
  SELECT id_cuenta, ghl_contact_id,
         array_agg(id_registro) AS registros
  FROM registros_de_llamada
  WHERE ghl_contact_id IS NOT NULL AND ghl_contact_id != ''
  GROUP BY id_cuenta, ghl_contact_id
  HAVING count(*) > 1
),
all_ids AS (
  SELECT unnest(registros) AS id_registro FROM dup_groups
)
INSERT INTO _backup_779_registros_de_llamada
SELECT r.* FROM registros_de_llamada r
JOIN all_ids a ON a.id_registro = r.id_registro;

WITH dup_groups AS (
  SELECT id_cuenta, ghl_contact_id,
         array_agg(id_registro) AS registros
  FROM registros_de_llamada
  WHERE ghl_contact_id IS NOT NULL AND ghl_contact_id != ''
  GROUP BY id_cuenta, ghl_contact_id
  HAVING count(*) > 1
),
all_ids AS (
  SELECT unnest(registros) AS id_registro FROM dup_groups
)
INSERT INTO _backup_779_log_llamadas
SELECT l.* FROM log_llamadas l
JOIN all_ids a ON a.id_registro = l.id_registro;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PASO 2: Merge
-- ═══════════════════════════════════════════════════════════════════════════════

-- CTE: identify mergeable groups and pick survivor
WITH dup_groups AS (
  SELECT id_cuenta, ghl_contact_id,
         array_agg(id_registro ORDER BY fecha_evento DESC NULLS LAST) AS registros,
         array_agg(estado ORDER BY fecha_evento DESC NULLS LAST) AS estados,
         array_agg(intentos_contacto ORDER BY fecha_evento DESC NULLS LAST) AS intentos_arr,
         bool_or(lower(estado) IN ('venta','ganado','ganada','perdido','perdida','cerrado','cerrada')) AS has_terminal,
         max(fecha_evento) AS max_fecha,
         min(fecha_evento) AS min_fecha
  FROM registros_de_llamada
  WHERE ghl_contact_id IS NOT NULL AND ghl_contact_id != ''
  GROUP BY id_cuenta, ghl_contact_id
  HAVING count(*) > 1
),
mergeable AS (
  SELECT *,
         registros[1] AS survivor_id,
         registros[2:] AS to_remove
  FROM dup_groups
  WHERE NOT has_terminal
    AND (max_fecha - min_fecha) < interval '30 days'
),

-- Compute consolidated intentos and best estado per group
merge_data AS (
  SELECT
    survivor_id,
    to_remove,
    -- Sum all intentos_contacto across the group
    (SELECT coalesce(sum(coalesce(intentos_contacto, 0)), 0)
     FROM registros_de_llamada
     WHERE id_registro = ANY(m.registros)) AS total_intentos,
    -- Pick best estado: calificada > seguimiento > programado > first non-null
    (SELECT estado FROM registros_de_llamada
     WHERE id_registro = ANY(m.registros)
       AND estado IS NOT NULL AND estado != ''
     ORDER BY
       CASE lower(estado)
         WHEN 'calificada' THEN 1
         WHEN 'seguimiento' THEN 2
         WHEN 'programado' THEN 3
         ELSE 4
       END,
       fecha_evento DESC NULLS LAST
     LIMIT 1) AS best_estado,
    -- Earliest fecha_evento for speed_to_lead accuracy
    (SELECT min(fecha_evento)
     FROM registros_de_llamada
     WHERE id_registro = ANY(m.registros)) AS earliest_fecha
  FROM mergeable m
),

-- Step 2a: Reassign log_llamadas from removed records to survivor
reassign AS (
  UPDATE log_llamadas l
  SET id_registro = md.survivor_id
  FROM merge_data md
  WHERE l.id_registro = ANY(md.to_remove)
  RETURNING l.id
),

-- Step 2b: Update survivor with consolidated data
update_survivor AS (
  UPDATE registros_de_llamada r
  SET intentos_contacto = md.total_intentos,
      estado = coalesce(md.best_estado, r.estado),
      fecha_evento = coalesce(r.fecha_evento, md.earliest_fecha)
  FROM merge_data md
  WHERE r.id_registro = md.survivor_id
  RETURNING r.id_registro
),

-- Step 2c: Delete surplus records
remove_ids AS (
  SELECT unnest(to_remove) AS id_registro FROM merge_data
),
delete_surplus AS (
  DELETE FROM registros_de_llamada
  WHERE id_registro IN (SELECT id_registro FROM remove_ids)
  RETURNING id_registro
)

-- Report
SELECT
  (SELECT count(*) FROM reassign) AS log_llamadas_reassigned,
  (SELECT count(*) FROM update_survivor) AS survivors_updated,
  (SELECT count(*) FROM delete_surplus) AS surplus_deleted;

COMMIT;

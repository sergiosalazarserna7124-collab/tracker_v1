-- AUT-1555: Backfill metricas_manual_data for cuenta 32 (patrimonio-para-tu-familia / Grupo mexa)
-- The metric 65497297-e5f5-45ee-9542-f8fc3073e937 was bucketed using UTC instead of America/Denver.
-- Recompute from log_llamadas tags_internos @> '["mql"]' grouped by DATE(ts AT TIME ZONE 'America/Denver').
-- Idempotent: uses jsonb_set and rebuilds only the affected metric_id.

DO $$
DECLARE
  v_metrica_id TEXT := '65497297-e5f5-45ee-9542-f8fc3073e937';
  v_id_cuenta  INT  := 32;
  v_tz         TEXT := 'America/Denver';
  v_new_entries JSONB;
BEGIN
  -- Build the correct entries from log_llamadas source of truth
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'date', dia::text,
      'valor', total,
      'keys', event_keys
    ) ORDER BY dia
  ), '[]'::jsonb)
  INTO v_new_entries
  FROM (
    SELECT
      DATE(ts AT TIME ZONE v_tz) AS dia,
      COUNT(*)::int AS total,
      array_agg('log:' || id::text) AS event_keys
    FROM log_llamadas
    WHERE id_cuenta = v_id_cuenta
      AND tags_internos @> '["mql"]'::jsonb
    GROUP BY 1
  ) sub;

  -- Only update if there are entries to write
  IF v_new_entries != '[]'::jsonb THEN
    UPDATE cuentas
    SET metricas_manual_data = COALESCE(metricas_manual_data, '{}'::jsonb) || jsonb_build_object(v_metrica_id, v_new_entries)
    WHERE id_cuenta = v_id_cuenta;

    RAISE NOTICE 'AUT-1555: Backfilled metric % for cuenta % with % entries: %',
      v_metrica_id, v_id_cuenta, jsonb_array_length(v_new_entries), v_new_entries;
  ELSE
    RAISE NOTICE 'AUT-1555: No MQL-tagged calls found for cuenta % — no backfill needed', v_id_cuenta;
  END IF;
END $$;

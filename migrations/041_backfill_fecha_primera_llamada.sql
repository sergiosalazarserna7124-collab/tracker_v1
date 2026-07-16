-- AUT-1621: Backfill fecha_primera_llamada en registros_de_llamada.
--
-- Bug reportado por Grupo Mexa (cuenta 32) en la videollamada del 2026-07-16:
-- leads que SÍ tienen llamadas aparecían marcados como "sin contacto".
--
-- Raíz: el write-path (twilio.service.ts / ghl-calls.service.ts) solo seteaba
-- fecha_primera_llamada cuando intentos_contacto === 0. Los registros que ya
-- tenían intentos > 0 con fecha_primera_llamada NULL (legacy, previos a la
-- introducción de la columna) nunca se sanaban: cualquier llamada posterior
-- incrementaba intentos pero jamás escribía la fecha. El write-path ya se
-- corrigió para setearla siempre que esté NULL; esta migración sana los
-- registros históricos usando la fecha real de la primera llamada en el
-- historial inmutable log_llamadas.
--
-- Idempotente: solo toca filas con fecha_primera_llamada IS NULL y con al menos
-- una llamada real en log_llamadas (excluye eventos 'pdte'/'contacto_creado').
-- Verificado (2026-07-17): ~11k filas afectadas SaaS-wide, 519 de cuenta 32.

DO $$
DECLARE
  v_updated INT;
BEGIN
  WITH first_calls AS (
    SELECT l.id_registro, MIN(l.ts) AS first_ts
    FROM log_llamadas l
    WHERE l.id_registro IS NOT NULL
      AND l.tipo_evento NOT IN ('pdte', 'contacto_creado')
    GROUP BY l.id_registro
  )
  UPDATE registros_de_llamada r
  SET fecha_primera_llamada = fc.first_ts
  FROM first_calls fc
  WHERE r.id_registro = fc.id_registro
    AND r.fecha_primera_llamada IS NULL
    AND fc.first_ts IS NOT NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'AUT-1621: fecha_primera_llamada backfilled en % registros', v_updated;
END $$;

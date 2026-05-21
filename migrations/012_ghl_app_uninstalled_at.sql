-- Migración 012: Banner de integración GHL desconectada (AUT-322)
--
-- Cuando el cliente desinstala la app de AutoKPI desde GHL, Cerebro recibe un
-- evento UNINSTALL. Esta columna registra eso para que el dashboard muestre
-- un aviso al cliente indicando que debe contactar a Sergio para reinstalar.
-- Se limpia automáticamente cuando llega el primer webhook real post-reinstalación.

ALTER TABLE cuentas
  ADD COLUMN IF NOT EXISTS ghl_app_uninstalled_at TIMESTAMPTZ;

-- Backfill: marcar cuentas cuyo último webhook fue exactamente UNINSTALL
-- (no tienen ningún webhook de mensaje después del evento UNINSTALL).
UPDATE cuentas c
SET ghl_app_uninstalled_at = uninstall_data.received_at
FROM (
  SELECT r.location_id, r.received_at
  FROM chat_webhook_raw r
  WHERE (r.payload->>'type') = 'UNINSTALL'
    AND NOT EXISTS (
      SELECT 1 FROM chat_webhook_raw r2
      WHERE r2.location_id = r.location_id
        AND r2.received_at > r.received_at
    )
) uninstall_data
WHERE (c.locationid = uninstall_data.location_id
   OR  c.ghl_location_id = uninstall_data.location_id)
  AND c.ghl_app_uninstalled_at IS NULL;

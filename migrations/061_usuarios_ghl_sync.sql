-- 061: Sync automático de usuarios GHL → usuarios_dashboard
--
-- - pass pasa a ser opcional (login sin contraseña: Google / código por email)
-- - ghl_user_id: id del usuario en GHL para mapear en syncs posteriores
-- - origen: 'manual' (creado en Lead Master) | 'ghl' (creado por el sync)
-- - activo: los usuarios origen='ghl' que desaparecen de la location se desactivan
-- - ghl_synced_at: última vez que el sync tocó la fila

ALTER TABLE usuarios_dashboard ALTER COLUMN pass DROP NOT NULL;

ALTER TABLE usuarios_dashboard ADD COLUMN IF NOT EXISTS ghl_user_id TEXT;
ALTER TABLE usuarios_dashboard ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE usuarios_dashboard ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE usuarios_dashboard ADD COLUMN IF NOT EXISTS ghl_synced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_usuarios_dashboard_cuenta_email
  ON usuarios_dashboard (id_cuenta, lower(email));

CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_dashboard_cuenta_ghl_user
  ON usuarios_dashboard (id_cuenta, ghl_user_id)
  WHERE ghl_user_id IS NOT NULL;

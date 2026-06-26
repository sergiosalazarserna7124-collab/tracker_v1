-- AUT-1077: tabla de mapeo ID externo cliente → contacto GHL
CREATE TABLE IF NOT EXISTS mapeo_id_externo (
  id             SERIAL PRIMARY KEY,
  id_cuenta      INTEGER NOT NULL REFERENCES cuentas(id_cuenta) ON DELETE CASCADE,
  id_cliente_interno TEXT NOT NULL,
  ghl_contact_id TEXT NOT NULL,
  telefono       TEXT,
  email          TEXT,
  nombre         TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mapeo_cuenta_cliente
  ON mapeo_id_externo (id_cuenta, id_cliente_interno);

CREATE INDEX IF NOT EXISTS idx_mapeo_cuenta_ghl
  ON mapeo_id_externo (id_cuenta, ghl_contact_id);

-- Ingesta de oportunidades de GHL (OpportunityCreate/Update/StatusUpdate/Delete).
-- Permite contar "oportunidades creadas" y relacionarlas al contacto/lead.

CREATE TABLE IF NOT EXISTS oportunidades (
  id_registro          SERIAL PRIMARY KEY,
  id_cuenta            INTEGER NOT NULL,
  ghl_opportunity_id   TEXT NOT NULL,
  ghl_contact_id       TEXT,
  pipeline_id          TEXT,
  pipeline_stage_id    TEXT,
  nombre               TEXT,
  status               TEXT,               -- open / won / lost / abandoned / deleted
  monetary_value       NUMERIC,
  fecha_creada         TIMESTAMPTZ,        -- dateAdded de GHL (cuándo se creó la oportunidad)
  fecha_actualizada    TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oportunidades_cuenta_oppid
  ON oportunidades (id_cuenta, ghl_opportunity_id);
CREATE INDEX IF NOT EXISTS idx_oportunidades_cuenta_contact
  ON oportunidades (id_cuenta, ghl_contact_id);
CREATE INDEX IF NOT EXISTS idx_oportunidades_cuenta_fecha
  ON oportunidades (id_cuenta, fecha_creada);

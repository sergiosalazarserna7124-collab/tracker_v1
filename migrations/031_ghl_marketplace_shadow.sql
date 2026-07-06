-- Shadow log para eventos crudos de la app GHL Marketplace (F1: solo observar)
CREATE TABLE IF NOT EXISTS ghl_marketplace_shadow (
  id            BIGSERIAL PRIMARY KEY,
  event_type    TEXT,
  location_id   TEXT,
  headers       JSONB NOT NULL DEFAULT '{}',
  payload       JSONB NOT NULL DEFAULT '{}',
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  signature_ok  BOOLEAN
);

CREATE INDEX IF NOT EXISTS idx_ghl_shadow_location
  ON ghl_marketplace_shadow (location_id);

CREATE INDEX IF NOT EXISTS idx_ghl_shadow_received
  ON ghl_marketplace_shadow (received_at);

ALTER TABLE cuentas
  ADD COLUMN IF NOT EXISTS ghl_opportunity_fields_config JSONB;

-- AUT-1805: BYOK Gemini — llave por tenant + gating premium
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS gemini_api_key text;
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS gemini_premium_status text DEFAULT 'off';

COMMENT ON COLUMN cuentas.gemini_api_key IS 'Llave Gemini del cliente (BYOK). NULL = premium apagado.';
COMMENT ON COLUMN cuentas.gemini_premium_status IS 'off | active | paused_invalid_key | paused_quota_exceeded';

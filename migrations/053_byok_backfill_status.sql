-- AUT-1808: BYOK Gemini backfill — tracking de estado y cap por tenant
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS gemini_backfill_status text;
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS gemini_backfill_cap integer DEFAULT 200;

COMMENT ON COLUMN cuentas.gemini_backfill_status IS 'null=no backfill | pending | running | completed | failed';
COMMENT ON COLUMN cuentas.gemini_backfill_cap IS 'Máximo de conversaciones por tabla en backfill BYOK (default 200)';

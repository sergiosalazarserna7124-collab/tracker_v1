-- AUT-889: per-account call classification config (word threshold + real conversation requirement)
-- NULL = current behavior (backward compat). Non-null = stricter rules.
-- Structure: {"min_palabras": 15, "requiere_conversacion_real": true}
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS config_llamadas JSONB DEFAULT NULL;

-- Activate for account 50 (Grupo Cenote) as requested
UPDATE cuentas
SET config_llamadas = '{"min_palabras": 15, "requiere_conversacion_real": true}'::jsonb
WHERE id_cuenta = 50;

-- AUT-272: Detección de closers duplicados
-- Requisito previo para el servicio closer-dedup.service.ts

-- Campo JSONB de reglas de merge en la tabla de cuentas
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS closer_merge_rules JSONB DEFAULT '[]'::jsonb;

-- Tabla de sugerencias de merge detectadas por IA
CREATE TABLE IF NOT EXISTS closer_merge_suggestions (
  id           SERIAL PRIMARY KEY,
  id_cuenta    INTEGER      NOT NULL,
  aliases      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  canonical_nombre TEXT     NOT NULL,
  canonical_email  TEXT,
  status       TEXT         NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resuelto_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cms_cuenta_status     ON closer_merge_suggestions(id_cuenta, status);
CREATE INDEX IF NOT EXISTS idx_cms_cuenta_created_at ON closer_merge_suggestions(id_cuenta, created_at DESC);

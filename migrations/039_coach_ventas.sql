-- AUT-1595: Coach de ventas — storage guion por categoría + motor evaluación
-- Idempotent (IF NOT EXISTS)

-- Gate de cuenta: solo evalúa cuentas con coach_habilitado = true
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS coach_habilitado BOOLEAN NOT NULL DEFAULT false;

-- Guiones de venta por categoría de llamada
CREATE TABLE IF NOT EXISTS guiones_coach (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cuenta INTEGER NOT NULL REFERENCES cuentas(id_cuenta) ON DELETE CASCADE,
  categoria_llamada_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  secciones JSONB NOT NULL,
  umbral INTEGER NOT NULL DEFAULT 70,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guiones_cuenta_cat ON guiones_coach (id_cuenta, categoria_llamada_id);

-- Evaluaciones de coach por llamada
CREATE TABLE IF NOT EXISTS evaluaciones_coach (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cuenta INTEGER NOT NULL REFERENCES cuentas(id_cuenta) ON DELETE CASCADE,
  log_llamada_id INTEGER NOT NULL,
  guion_id UUID NOT NULL REFERENCES guiones_coach(id) ON DELETE CASCADE,
  guion_version INTEGER NOT NULL,
  scores_secciones JSONB NOT NULL,
  score_total INTEGER NOT NULL,
  cumple_umbral BOOLEAN NOT NULL,
  secciones_faltantes_must_have JSONB,
  nota_accionable TEXT,
  ghl_tag_applied TEXT,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_cuenta_llamada ON evaluaciones_coach (id_cuenta, log_llamada_id);
CREATE INDEX IF NOT EXISTS idx_eval_guion ON evaluaciones_coach (guion_id);

-- Activar coach solo en c33 (sharkrealtor) para rollout inicial
UPDATE cuentas SET coach_habilitado = true WHERE id_cuenta = 33;

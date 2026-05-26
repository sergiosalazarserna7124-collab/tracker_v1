-- Tablas para métricas personalizadas por cuenta (AUT-417)
-- metrics: catálogo de métricas configurables por tenant
-- metric_data_points: puntos de datos por métrica con timestamp

CREATE TABLE IF NOT EXISTS metrics (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cuenta  INTEGER NOT NULL REFERENCES cuentas(id_cuenta) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metrics_cuenta ON metrics (id_cuenta);

CREATE TABLE IF NOT EXISTS metric_data_points (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_id UUID NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
  id_cuenta INTEGER NOT NULL REFERENCES cuentas(id_cuenta) ON DELETE CASCADE,
  value     TEXT NOT NULL,
  ts        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mdp_metric_cuenta_ts
  ON metric_data_points (metric_id, id_cuenta, ts);

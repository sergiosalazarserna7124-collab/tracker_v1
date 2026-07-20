-- Tabla de métricas enviadas por webhook (n8n → Cerebro)
-- Idempotente: la tabla y los índices ya existen en prod.

CREATE TABLE IF NOT EXISTS metricas_webhook (
  id              SERIAL PRIMARY KEY,
  id_cuenta       INTEGER NOT NULL REFERENCES cuentas(id_cuenta) ON DELETE CASCADE,
  fecha           DATE NOT NULL,
  campo           TEXT NOT NULL,
  valor           NUMERIC(18,4) NOT NULL DEFAULT 0,
  ghl_user_id     TEXT,
  ghl_customer_id TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metricas_webhook_cuenta_fecha
  ON metricas_webhook (id_cuenta, fecha);

CREATE INDEX IF NOT EXISTS idx_metricas_webhook_user
  ON metricas_webhook (id_cuenta, ghl_user_id)
  WHERE ghl_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS metricas_webhook_unique
  ON metricas_webhook (id_cuenta, fecha, campo, ghl_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_metricas_webhook_global
  ON metricas_webhook (id_cuenta, fecha, campo)
  WHERE ghl_user_id IS NULL;

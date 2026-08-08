-- Apartados y ventas por etiqueta (AUT: métricas financieras del panel).
-- Etiqueta "apartado" en el contacto → apartado=true + monto_apartado (campo
-- custom de oportunidad "Monto de apartado") + fecha_apartado.
-- Etiqueta "compro" → venta=true + monto_venta (value de la oportunidad) +
-- fecha_venta. Reversible: al quitar la etiqueta se limpia el flag.

ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS apartado       BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS monto_apartado NUMERIC;
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS fecha_apartado TIMESTAMPTZ;
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS venta          BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS monto_venta    NUMERIC;
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS fecha_venta    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_oportunidades_apartado
  ON oportunidades (id_cuenta, fecha_apartado) WHERE apartado;
CREATE INDEX IF NOT EXISTS idx_oportunidades_venta
  ON oportunidades (id_cuenta, fecha_venta) WHERE venta;

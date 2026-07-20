-- AUT-1663: Etiquetas de descarte de leads
-- Adds per-tenant configurable discard labels + excluido_metricas flag for chats

-- 1. Config de etiquetas de descarte por tenant (array de strings)
ALTER TABLE cuentas
  ADD COLUMN IF NOT EXISTS etiquetas_descarte jsonb;

-- 2. Flag excluido_metricas en chats_logs (parallel to registros_de_llamada.excluido_metricas)
ALTER TABLE chats_logs
  ADD COLUMN IF NOT EXISTS excluido_metricas boolean NOT NULL DEFAULT false;

-- 3. Index parcial para queries de métricas (excluir descartados eficientemente)
CREATE INDEX IF NOT EXISTS idx_chats_excluido_metricas
  ON chats_logs (id_cuenta, excluido_metricas)
  WHERE excluido_metricas = true;

CREATE INDEX IF NOT EXISTS idx_rdl_excluido_metricas
  ON registros_de_llamada (id_cuenta, excluido_metricas)
  WHERE excluido_metricas = true;

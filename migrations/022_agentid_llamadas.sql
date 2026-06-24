-- AUT-1028: agentid del Voice Agent para routing multi-tenant
-- Columna nullable text en ambas tablas de llamadas.

ALTER TABLE registros_de_llamada
  ADD COLUMN IF NOT EXISTS agentid text;

ALTER TABLE log_llamadas
  ADD COLUMN IF NOT EXISTS agentid text;

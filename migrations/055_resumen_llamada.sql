-- AUT-1945: resumen estructurado de llamada (ubicación, objetivo, presupuesto, quién decide, desenlace)
ALTER TABLE registros_de_llamada ADD COLUMN IF NOT EXISTS resumen_llamada JSONB;
ALTER TABLE log_llamadas ADD COLUMN IF NOT EXISTS resumen_llamada JSONB;

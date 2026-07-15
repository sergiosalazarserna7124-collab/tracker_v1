-- AUT-1599: Unique constraint on evaluaciones_coach(id_cuenta, log_llamada_id)
-- Prevents duplicate evaluations from overlapping drainer runs
-- Idempotent: drops old non-unique index, creates unique index IF NOT EXISTS

DROP INDEX IF EXISTS idx_eval_cuenta_llamada;
CREATE UNIQUE INDEX IF NOT EXISTS uq_eval_cuenta_llamada ON evaluaciones_coach (id_cuenta, log_llamada_id);

-- 048: Coach multicanal — discriminador de canal en guiones y evaluaciones
-- Permite evaluar chats y videollamadas además de llamadas telefónicas.

-- 1. Agregar columna canal a guiones_coach (default 'llamada' para backwards compat)
ALTER TABLE guiones_coach ADD COLUMN IF NOT EXISTS canal TEXT NOT NULL DEFAULT 'llamada';

-- Índice compuesto para lookup: (id_cuenta, canal, categoria_llamada_id)
CREATE INDEX IF NOT EXISTS idx_guiones_cuenta_canal_cat
  ON guiones_coach (id_cuenta, canal, categoria_llamada_id);

-- 2. Agregar columna canal a evaluaciones_coach
ALTER TABLE evaluaciones_coach ADD COLUMN IF NOT EXISTS canal TEXT NOT NULL DEFAULT 'llamada';

-- Reemplazar el unique index para incluir canal (permite mismo origen_id en distintos canales)
DROP INDEX IF EXISTS uq_eval_cuenta_llamada;
CREATE UNIQUE INDEX IF NOT EXISTS uq_eval_cuenta_canal_origen
  ON evaluaciones_coach (id_cuenta, canal, log_llamada_id);

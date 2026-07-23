-- 049: Coach notas por prompt, etiquetas y exclusiones de análisis (AUT-1767)
-- Permite configurar notas/tags distintas según cumplimiento y excluir leads del análisis.

-- 1. Notas por prompt en guiones_coach
-- Prompts configurables: el LLM genera la nota usando este texto como instrucción.
ALTER TABLE guiones_coach ADD COLUMN IF NOT EXISTS nota_cumplido TEXT;
ALTER TABLE guiones_coach ADD COLUMN IF NOT EXISTS nota_no_cumplido TEXT;

-- 2. Tags por cumplimiento en guiones_coach
-- Shape: string[] — nombres de etiquetas GHL a aplicar según cumplimiento.
ALTER TABLE guiones_coach ADD COLUMN IF NOT EXISTS tags_cumplido JSONB;
ALTER TABLE guiones_coach ADD COLUMN IF NOT EXISTS tags_no_cumplido JSONB;

-- 3. Exclusiones de análisis por tenant
-- Shape: { reglas: Array<{ canal: string, campo: string, operador: string, valor: string }> }
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS exclusiones_coach JSONB;

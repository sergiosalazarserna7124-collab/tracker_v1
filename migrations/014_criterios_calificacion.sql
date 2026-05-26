-- Agrega columna JSONB criterios_calificacion en tabla cuentas (AUT-413)
-- Estructura: {"categorias_calificadas": ["presupuesto", "urgencia", ...], "umbral_minimo": 1}
-- NULL = fallback al comportamiento actual (todos los chats calificados)

ALTER TABLE cuentas
  ADD COLUMN IF NOT EXISTS criterios_calificacion JSONB DEFAULT NULL;

COMMENT ON COLUMN cuentas.criterios_calificacion IS
  'Criterios de calificación de leads por cuenta. '
  'Estructura: {"categorias_calificadas": string[], "umbral_minimo": number}. '
  'NULL = todos los chats son calificados (backward compat).';

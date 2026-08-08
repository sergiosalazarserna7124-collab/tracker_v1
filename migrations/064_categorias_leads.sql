-- 064: Categorías de LEADS unificadas — evaluación conjunta por etapa.
-- [{ id, nombre, etiqueta, prompt, prompt_resumen, reglas_etiquetas: [{id, tag, condition}] }]
-- La etiqueta del contacto en GHL determina su etapa; TODA interacción
-- (chat, llamada, cita) se evalúa con el prompt de esa etapa, se resume con su
-- prompt de resumen, y las reglas de etiquetas de la etapa aplican solo ahí.

ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS categorias_leads JSONB;

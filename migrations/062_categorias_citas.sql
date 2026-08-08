-- 062: Categorías de evaluación de citas (videollamadas) ancladas a etiqueta GHL.
-- [{ id, nombre, etiqueta, prompt }] — si el contacto tiene la etiqueta, la cita
-- se evalúa con el prompt de esa categoría. Mismo patrón que categorias_llamadas
-- (que ahora también acepta el campo etiqueta en su JSON).

ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS categorias_citas JSONB;

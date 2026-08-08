-- 063: Categorías de evaluación de chats ancladas a etiqueta GHL.
-- Mismo patrón que categorias_citas (062): [{ id, nombre, etiqueta, prompt }].

ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS categorias_chats JSONB;

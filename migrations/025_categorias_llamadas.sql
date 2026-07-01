-- AUT-1143: categorías de llamada con prompt por categoría
-- Estructura: Array<{ id: string; nombre: string; temas: string[]; prompt: string }>
ALTER TABLE cuentas
  ADD COLUMN IF NOT EXISTS categorias_llamadas JSONB DEFAULT NULL;

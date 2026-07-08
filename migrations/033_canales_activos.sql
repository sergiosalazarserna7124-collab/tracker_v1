-- AUT-1330: columna canales_activos en cuentas
-- Shape: { chats: boolean, llamadas: boolean, videollamadas: boolean }
-- NULL = todos los canales activos (backwards-compat)
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS canales_activos JSONB;

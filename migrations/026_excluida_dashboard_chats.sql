-- AUT-1162: columna para excluir chats del dashboard (tag GHL "descartar")
ALTER TABLE chats_logs
  ADD COLUMN IF NOT EXISTS excluida_dashboard boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_chats_logs_excluida
  ON chats_logs (id_cuenta, excluida_dashboard)
  WHERE excluida_dashboard = false;

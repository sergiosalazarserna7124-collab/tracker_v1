-- AUT-1762: Speed-to-lead post-delegación del bot
-- Almacena el timestamp de cuando el chatbot delegó al asesor humano
-- (mensaje que contiene el chatbot_transfer_marker de la cuenta).

ALTER TABLE chats_logs ADD COLUMN IF NOT EXISTS bot_delegacion_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_chats_bot_delegacion
  ON chats_logs (bot_delegacion_at) WHERE bot_delegacion_at IS NOT NULL;

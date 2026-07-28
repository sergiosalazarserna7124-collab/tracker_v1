-- Marca para no re-procesar chats donde ya se verificó si hay mensajes salientes en GHL
ALTER TABLE chats_logs ADD COLUMN IF NOT EXISTS outbound_enriched_at TIMESTAMPTZ;

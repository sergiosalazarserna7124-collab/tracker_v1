-- 065_chats_ia_resumen.sql
-- Resumen IA "en qué quedó la conversación" para chats.
-- Lo genera analyzeChatWithAI (mismo call que ya clasifica) y lo consumen el detalle
-- del asesor (Estado del chat → "En qué quedó") en el frontend.

ALTER TABLE chats_logs
  ADD COLUMN IF NOT EXISTS ia_resumen text;

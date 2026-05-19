-- Migración 005: Agregar chatbot_transfer_marker en cuentas
-- Propósito: Soporte para detección de transferencia chatbot→humano (AUT-254)
--
-- Algunas cuentas tienen chatbot configurado. Para esas cuentas,
-- primer_msg_lead_at debe calcularse desde el primer mensaje del lead
-- DESPUÉS del mensaje de transferencia del chatbot al humano,
-- no desde el primer mensaje absoluto al bot.
--
-- chatbot_transfer_marker: texto/emoji que aparece en el mensaje de transferencia.
-- NULL = cuenta sin chatbot (lógica actual: primer mensaje lead absoluto).
-- Valor ej: '🤝', '✅ Transferido', etc. — definido por cada cuenta.

ALTER TABLE cuentas
  ADD COLUMN IF NOT EXISTS chatbot_transfer_marker TEXT;

COMMENT ON COLUMN cuentas.chatbot_transfer_marker IS
  'Texto/emoji que aparece en el mensaje de transferencia chatbot→humano. '
  'NULL = cuenta sin chatbot. Usado por backfillPrimerMsgLeadAt para calcular '
  'speed-to-lead real excluyendo tiempo en bot.';

-- Migración 003: Limpiar primer_msg_lead_at corrupto en chats_logs (AUT-181)
--
-- Problema: El webhook handler usaba new Date().toISOString() (NOW) cuando
-- dateAdded estaba ausente en el payload. Esto producía primer_msg_lead_at ≈
-- fecha_y_hora_z del mismo upsert → speed-to-lead ≈ 0 segundos → "0.0 min"
-- en el dashboard.
--
-- Fix en código: chat.service.ts ya corregido para usar null en lugar de NOW()
-- cuando dateAdded está ausente. Este script corrige los datos históricos.
--
-- Estrategia de limpieza:
--   1. Si el JSONB chat tiene al menos un mensaje lead con timestamp válido,
--      re-derivar primer_msg_lead_at desde ahí (mínimo timestamp inbound lead).
--   2. Si no hay timestamps válidos en JSONB, poner NULL para excluir el chat
--      del cálculo de speed-to-lead en lugar de mostrar valor engañoso.
--
-- Los registros con primer_msg_lead_at = NULL se excluyen del cálculo;
-- los que tengan timestamp real (dateAdded presente en webhook original)
-- permanecen intactos gracias al COALESCE en el upsert.

-- Paso 1: Actualizar registros donde podemos derivar timestamp real desde JSONB
UPDATE chats_logs
SET primer_msg_lead_at = (
  SELECT MIN((msg->>'timestamp')::timestamptz)
  FROM jsonb_array_elements(chat) AS msg
  WHERE msg->>'role' = 'lead'
    AND msg->>'timestamp' IS NOT NULL
    AND (msg->>'timestamp') <> ''
    AND (msg->>'timestamp')::timestamptz > '2020-01-01'::timestamptz
)
WHERE chat IS NOT NULL
  AND jsonb_array_length(chat) > 0
  AND primer_msg_lead_at IS NOT NULL
  -- Solo tocar registros cuyo primer_msg_lead_at es sospechoso:
  -- si está dentro de 30 segundos de algun mensaje lead en el JSONB,
  -- probablemente fue asignado correctamente; si no hay coincidencia,
  -- re-derivamos. La forma más segura: re-derivar siempre y comparar.
  AND (
    SELECT MIN((msg->>'timestamp')::timestamptz)
    FROM jsonb_array_elements(chat) AS msg
    WHERE msg->>'role' = 'lead'
      AND msg->>'timestamp' IS NOT NULL
      AND (msg->>'timestamp') <> ''
      AND (msg->>'timestamp')::timestamptz > '2020-01-01'::timestamptz
  ) IS NOT NULL;

-- Paso 2: Para registros sin timestamp real en JSONB, poner NULL
-- (excluye del speed-to-lead en lugar de mostrar 0.0 engañoso)
UPDATE chats_logs
SET primer_msg_lead_at = NULL
WHERE primer_msg_lead_at IS NOT NULL
  AND (
    chat IS NULL
    OR jsonb_array_length(chat) = 0
    OR NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(chat) AS msg
      WHERE msg->>'role' = 'lead'
        AND msg->>'timestamp' IS NOT NULL
        AND (msg->>'timestamp') <> ''
        AND (msg->>'timestamp')::timestamptz > '2020-01-01'::timestamptz
    )
  );

-- Verificación post-migración (ejecutar manualmente para confirmar):
-- SELECT id_cuenta, COUNT(*) total,
--        COUNT(primer_msg_lead_at) con_timestamp,
--        COUNT(*) - COUNT(primer_msg_lead_at) sin_timestamp
-- FROM chats_logs
-- GROUP BY id_cuenta
-- ORDER BY total DESC;

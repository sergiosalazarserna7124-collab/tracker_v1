-- Migración 016: Trigger para auto-llenar primer_msg_at en chats_logs (AUT-690)
--
-- Problema: un writer externo (no Cerebro Cloud Run) inserta/actualiza filas
-- en chats_logs SIN setear primer_msg_at. Cerebro sí lo hace, pero el webhook
-- de chat GHL no apunta a Cloud Run.
--
-- Solución: trigger BEFORE INSERT OR UPDATE que calcula primer_msg_at
-- desde el JSONB chat cuando la columna queda NULL.

CREATE OR REPLACE FUNCTION fn_auto_primer_msg_at()
RETURNS TRIGGER AS $$
BEGIN
  -- Solo actuar si primer_msg_at es NULL y hay mensajes en chat
  IF NEW.primer_msg_at IS NULL AND NEW.chat IS NOT NULL AND jsonb_array_length(NEW.chat) > 0 THEN
    NEW.primer_msg_at := (
      SELECT MIN((msg->>'timestamp')::timestamptz)
      FROM jsonb_array_elements(NEW.chat) AS msg
      WHERE msg->>'timestamp' IS NOT NULL
        AND msg->>'timestamp' <> ''
        AND (msg->>'timestamp')::timestamptz > '2020-01-01'::timestamptz
    );
    -- Fallback: si no hay timestamps válidos en JSONB, usar fecha_y_hora_z o NOW()
    IF NEW.primer_msg_at IS NULL THEN
      NEW.primer_msg_at := COALESCE(NEW.primer_msg_lead_at, NEW.fecha_y_hora_z, NOW());
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Aplicar trigger en INSERT y UPDATE
DROP TRIGGER IF EXISTS trg_auto_primer_msg_at ON chats_logs;
CREATE TRIGGER trg_auto_primer_msg_at
  BEFORE INSERT OR UPDATE ON chats_logs
  FOR EACH ROW
  EXECUTE FUNCTION fn_auto_primer_msg_at();

-- Backfill one-time: rellenar las ~18k filas existentes con NULL
UPDATE chats_logs
SET primer_msg_at = (
  SELECT MIN((msg->>'timestamp')::timestamptz)
  FROM jsonb_array_elements(chat) AS msg
  WHERE msg->>'timestamp' IS NOT NULL
    AND msg->>'timestamp' <> ''
    AND (msg->>'timestamp')::timestamptz > '2020-01-01'::timestamptz
)
WHERE primer_msg_at IS NULL
  AND chat IS NOT NULL
  AND jsonb_array_length(chat) > 0;

-- Fallback para filas sin timestamps en JSONB
UPDATE chats_logs
SET primer_msg_at = COALESCE(primer_msg_lead_at, fecha_y_hora_z)
WHERE primer_msg_at IS NULL;

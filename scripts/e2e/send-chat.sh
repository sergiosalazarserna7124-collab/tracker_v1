#!/usr/bin/env bash
# Envía un evento de chat GHL al Cerebro apuntando al tenant demo (52).
# Uso: ./scripts/e2e/send-chat.sh [message_body] [direction]
#   message_body: texto del mensaje (default: una demo)
#   direction:    inbound|outbound (default: inbound)
set -euo pipefail

CEREBRO_URL="${CEREBRO_URL:-https://cerebro-tracker-v6-saas-git-cstkjl7bpa-ue.a.run.app}"
DEMO_LOCATION_ID="QfAM4c37M8mR2xBxqJaJ"

MESSAGE_BODY="${1:-Hola, me interesa saber más sobre el servicio de tracking de ventas. ¿Tienen disponibilidad para una demo esta semana?}"
DIRECTION="${2:-inbound}"
MSG_ID="e2e-msg-$(date +%s)-$$"
CONV_ID="e2e-conv-$(date +%s)"
CONTACT_ID="e2e-contact-$(date +%s)"

PAYLOAD=$(jq -n \
  --arg type "InboundMessage" \
  --arg contentType "text/plain" \
  --arg status "delivered" \
  --arg locationId "$DEMO_LOCATION_ID" \
  --arg conversationId "$CONV_ID" \
  --arg contactId "$CONTACT_ID" \
  --arg direction "$DIRECTION" \
  --arg messageType "TYPE_WHATSAPP" \
  --arg body "$MESSAGE_BODY" \
  --arg dateAdded "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
  --arg id "$MSG_ID" \
  '{
    type: $type,
    contentType: $contentType,
    status: $status,
    locationId: $locationId,
    conversationId: $conversationId,
    contactId: $contactId,
    direction: $direction,
    messageType: $messageType,
    body: $body,
    dateAdded: $dateAdded,
    id: $id,
    contact: {
      id: $contactId,
      name: "E2E Test Lead",
      firstName: "E2E",
      lastName: "TestLead",
      phone: "+5215598765432",
      email: "e2e-test@demo.autokpi.net"
    }
  }')

echo "=== E2E: Enviando chat GHL al tenant demo (52) ==="
echo "  msg_id:     $MSG_ID"
echo "  direction:  $DIRECTION"
echo "  locationId: $DEMO_LOCATION_ID"
echo "  endpoint:   $CEREBRO_URL/webhooks/chat"
echo ""

HTTP_CODE=$(curl -s -o /tmp/e2e-chat-response.json -w "%{http_code}" \
  -X POST "$CEREBRO_URL/webhooks/chat" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

echo "  HTTP status: $HTTP_CODE"
echo "  Response:    $(cat /tmp/e2e-chat-response.json)"
echo ""

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: Cerebro respondió $HTTP_CODE"
  exit 1
fi

echo "Esperando 8s para que el procesamiento async termine..."
sleep 8

echo ""
echo "=== Verificando en BD ==="
PGPASSWORD=readonly_autokpi_2026 psql -h mainbd.automatizacionesia.com -p 5432 \
  -U agente_readonly -d postgres -c \
  "SELECT id_evento, id_cuenta, nombre_lead, fecha_y_hora_z, origen, estado
   FROM chats_logs
   WHERE id_cuenta = 52
   ORDER BY fecha_y_hora_z DESC
   LIMIT 3;"

echo ""
echo "  Dashboard: https://demo.autokpi.net"
echo "  msg_id enviado: $MSG_ID"

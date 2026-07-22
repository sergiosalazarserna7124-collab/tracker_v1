#!/usr/bin/env bash
# Envía un evento de llamada CallAI (voz) al Cerebro apuntando al tenant demo (52).
# Uso: ./scripts/e2e/send-call.sh [transcript] [estado]
#   transcript: texto de la transcripción (default: una demo)
#   estado:     interesado|no_interesado|reagendado|... (default: interesado)
set -euo pipefail

CEREBRO_URL="${CEREBRO_URL:-https://cerebro-tracker-v6-saas-git-cstkjl7bpa-ue.a.run.app}"
# Secret de escritura del endpoint de voz — NO se hardcodea. Debe pasarse por env:
#   VOZ_SECRET=voz_xxxxx ./scripts/e2e/send-call.sh
VOZ_SECRET="${VOZ_SECRET:?falta VOZ_SECRET — exporta el secret de voz (x-voz-secret) antes de correr este script}"
DEMO_ACCOUNT_ID=52

TRANSCRIPT="${1:-Vendedor: Hola buenas tardes, le llamo de parte de AutoKPI. ¿Me permite un momento? Cliente: Sí claro, dígame. Vendedor: Perfecto, le comento que tenemos una solución de tracking de ventas que le ayudaría a medir el rendimiento de su equipo. Cliente: Suena interesante, ¿cuánto cuesta? Vendedor: Tenemos planes desde 97 dólares al mes. ¿Le gustaría agendar una demo? Cliente: Sí, agéndeme para el jueves por favor.}"
ESTADO="${2:-interesado}"
CALL_ID="e2e-test-$(date +%s)-$$"

PAYLOAD=$(jq -n \
  --arg event "call.completed" \
  --arg call_id "$CALL_ID" \
  --argjson accountid "$DEMO_ACCOUNT_ID" \
  --arg estado "$ESTADO" \
  --arg phone "+5215512345678" \
  --arg transcript "$TRANSCRIPT" \
  --arg short_summary "Lead interesado en demo de AutoKPI. Agendó para el jueves." \
  --arg ended_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson duration_seconds 180 \
  --arg broker_name "Demo Closer" \
  --arg broker_company "AutoKPI Demo" \
  '{
    event: $event,
    call_id: $call_id,
    accountid: $accountid,
    estado: $estado,
    phone: $phone,
    transcript: $transcript,
    short_summary: $short_summary,
    ended_at: $ended_at,
    duration_seconds: $duration_seconds,
    broker_name: $broker_name,
    broker_company: $broker_company
  }')

echo "=== E2E: Enviando llamada CallAI al tenant demo (52) ==="
echo "  call_id:  $CALL_ID"
echo "  estado:   $ESTADO"
echo "  endpoint: $CEREBRO_URL/webhooks/voz"
echo ""

HTTP_CODE=$(curl -s -o /tmp/e2e-call-response.json -w "%{http_code}" \
  -X POST "$CEREBRO_URL/webhooks/voz" \
  -H "Content-Type: application/json" \
  -H "x-voz-secret: $VOZ_SECRET" \
  -d "$PAYLOAD")

echo "  HTTP status: $HTTP_CODE"
echo "  Response:    $(cat /tmp/e2e-call-response.json)"
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
  "SELECT id_registro, id_cuenta, nombre_lead, phone_raw_format, estado, fecha_evento, callsid
   FROM registros_de_llamada
   WHERE id_cuenta = '$DEMO_ACCOUNT_ID'
   ORDER BY fecha_evento DESC
   LIMIT 3;"

echo ""
echo "  Dashboard: https://demo.autokpi.net"
echo "  call_id enviado: $CALL_ID"

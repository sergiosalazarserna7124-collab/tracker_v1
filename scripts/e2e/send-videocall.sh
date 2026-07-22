#!/usr/bin/env bash
# Envía un evento de videollamada Fathom al Cerebro apuntando al tenant demo (52).
# Uso: ./scripts/e2e/send-videocall.sh [meeting_title]
#   meeting_title: título de la reunión (default: una demo)
set -euo pipefail

CEREBRO_URL="${CEREBRO_URL:-https://cerebro-tracker-v6-saas-git-cstkjl7bpa-ue.a.run.app}"
DEMO_ACCOUNT_ID=52

MEETING_TITLE="${1:-Demo AutoKPI — Reunión de ventas E2E}"
RECORDING_ID=$((RANDOM * RANDOM))
NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
END_ISO=$(date -u -d "+45 minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+45M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$NOW_ISO")

PAYLOAD=$(jq -n \
  --argjson recording_id "$RECORDING_ID" \
  --arg share_url "https://fathom.video/share/e2e-test-$RECORDING_ID" \
  --arg title "$MEETING_TITLE" \
  --arg created_at "$NOW_ISO" \
  --arg scheduled_start_time "$NOW_ISO" \
  --arg scheduled_end_time "$END_ISO" \
  --arg recording_start_time "$NOW_ISO" \
  --arg recording_end_time "$END_ISO" \
  '{
    recording_id: $recording_id,
    share_url: $share_url,
    title: $title,
    created_at: $created_at,
    scheduled_start_time: $scheduled_start_time,
    scheduled_end_time: $scheduled_end_time,
    recording_start_time: $recording_start_time,
    recording_end_time: $recording_end_time,
    recorded_by: {
      email: "closer-demo@autokpi.net",
      name: "Demo Closer",
      email_domain: "autokpi.net"
    },
    calendar_invitees: [
      {
        email: "closer-demo@autokpi.net",
        is_external: false,
        name: "Demo Closer",
        matched_speaker_display_name: "Demo Closer"
      },
      {
        email: "lead-e2e@example.com",
        is_external: true,
        name: "E2E Test Lead",
        matched_speaker_display_name: "E2E Lead"
      }
    ],
    transcript: [
      {
        speaker: { display_name: "Demo Closer", matched_calendar_invitee_email: "closer-demo@autokpi.net" },
        text: "Hola buenas tardes, bienvenido a la demo de AutoKPI.",
        timestamp: "00:00:05"
      },
      {
        speaker: { display_name: "E2E Lead", matched_calendar_invitee_email: "lead-e2e@example.com" },
        text: "Gracias, estoy interesado en ver cómo funciona el tracking de llamadas.",
        timestamp: "00:00:15"
      },
      {
        speaker: { display_name: "Demo Closer", matched_calendar_invitee_email: "closer-demo@autokpi.net" },
        text: "Perfecto, le voy a mostrar el dashboard donde puede ver todas las métricas de su equipo de ventas en tiempo real.",
        timestamp: "00:00:25"
      },
      {
        speaker: { display_name: "E2E Lead", matched_calendar_invitee_email: "lead-e2e@example.com" },
        text: "Excelente, ¿cuánto cuesta el plan mensual? Me gustaría empezar lo antes posible.",
        timestamp: "00:01:00"
      },
      {
        speaker: { display_name: "Demo Closer", matched_calendar_invitee_email: "closer-demo@autokpi.net" },
        text: "Tenemos planes desde 97 dólares al mes. Vamos a proceder con el siguiente paso para activar su cuenta.",
        timestamp: "00:01:30"
      }
    ]
  }')

echo "=== E2E: Enviando videollamada Fathom al tenant demo (52) ==="
echo "  recording_id: $RECORDING_ID"
echo "  title:        $MEETING_TITLE"
echo "  endpoint:     $CEREBRO_URL/webhooks/fathom/$DEMO_ACCOUNT_ID"
echo ""

HTTP_CODE=$(curl -s -o /tmp/e2e-videocall-response.json -w "%{http_code}" \
  -X POST "$CEREBRO_URL/webhooks/fathom/$DEMO_ACCOUNT_ID" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

echo "  HTTP status: $HTTP_CODE"
echo "  Response:    $(cat /tmp/e2e-videocall-response.json)"
echo ""

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: Cerebro respondió $HTTP_CODE"
  exit 1
fi

echo "Esperando 15s para que la transcripción/clasificación termine..."
sleep 15

echo ""
echo "=== Verificando en BD ==="
PGPASSWORD=readonly_autokpi_2026 psql -h mainbd.automatizacionesia.com -p 5432 \
  -U agente_readonly -d postgres -c \
  "SELECT id_registro_agenda, id_cuenta, closer, nombre_de_lead, categoria, fecha_reunion, fathom_recording_id
   FROM resumenes_diarios_agendas
   WHERE id_cuenta = $DEMO_ACCOUNT_ID
   ORDER BY fecha_reunion DESC
   LIMIT 3;"

echo ""
echo "  Dashboard: https://demo.autokpi.net"
echo "  recording_id enviado: $RECORDING_ID"
echo ""
echo "NOTA: Si no aparecen registros, verificar logs de Cerebro."
echo "El flujo Fathom depende de que el email del lead exista como contacto"
echo "en GHL para la cuenta. Si el contacto no existe en GHL, nombre_de_lead"
echo "queda NULL y el INSERT falla por constraint NOT NULL."

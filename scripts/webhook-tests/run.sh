#!/usr/bin/env bash
# Runner de pruebas de webhooks (capa branded /lm/webhook/*).
# Uso:
#   BASE_URL=http://localhost:8080 API_KEY=wht_test_key_123456 ./run.sh
#   BASE_URL=https://webhooks.leadmaster.com.co ./run.sh    (produccion)
#
# Cuenta de prueba: id_cuenta=1, locationid="test"
set -u
BASE_URL="${BASE_URL:-http://localhost:8080}"
API_KEY="${API_KEY:-wht_test_key_123456}"
DIR="$(cd "$(dirname "$0")" && pwd)/payloads"

fire() {  # $1=nombre  $2=metodo-path  $3=archivo  $4=extra-header(opcional)
  local name="$1" path="$2" file="$3" hdr="${4:-}"
  echo "──────────────────────────────────────────────"
  echo "▶ $name"
  echo "  POST $BASE_URL$path"
  local code
  code=$(curl -s -o /tmp/wht_resp.json -w "%{http_code}" -m 60 \
    -X POST "$BASE_URL$path" \
    -H "Content-Type: application/json" \
    ${hdr:+-H "$hdr"} \
    --data @"$DIR/$file")
  echo "  HTTP $code"
  echo "  Resp: $(head -c 400 /tmp/wht_resp.json)"
  echo
}

echo "== BASE_URL=$BASE_URL =="
fire "1) Llamada pendiente (setup)"            "/lm/webhook/llamada/pending"      01-llamada-pending.json
sleep 1
fire "2) Llamada efectiva con OBJECIONES"      "/lm/webhook/llamada/effective"    02-llamada-effective-objeciones.json
fire "3) Llamada NO CONTESTADA"                "/lm/webhook/llamada/no-answer"     03-llamada-no-answer.json
fire "4) Videollamada efectiva (Fathom)"       "/lm/webhook/videollamada/1"       04-videollamada-fathom.json
# La cita crea la agenda PDTE que la asistencia luego marca como asistida.
fire "5) Recorrido agendado (cita)"            "/lm/webhook/cita"                  09-cita-recorrido-agendado.json
sleep 1
fire "6) Videollamada asistida (asistencia via GHL)" "/lm/webhook/asistencia/1"    05-asistencia-asistio.json
fire "7) Contacto creado"                      "/lm/webhook/contacto"              06-contacto.json  "Authorization: Bearer $API_KEY"
fire "8) Reasignacion de asesor"               "/lm/webhook/reasignacion"          07-reasignacion.json
fire "9) Lead DESCARTADO"                       "/lm/webhook/calificacion/test"     08-calificacion-descartado.json
fire "10) Recorridos/Apartados/Ventas (metricas)" "/lm/webhook/metricas/test"     10-metricas-recorridos-apartados-ventas.json "x-cron-secret: $CRON_SECRET"
echo "== FIN =="

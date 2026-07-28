# Métricas Custom — Contrato Canónico

Endpoint para registrar cualquier métrica personalizada por webhook (recorridos, apartados, etc.).

## Endpoints disponibles

| Endpoint | Auth | Notas |
|---|---|---|
| **Cerebro** `POST /webhooks/metricas/{locationId}` | `x-cron-secret` | Usa el CRON_SECRET del Cerebro |
| **Dashboard** `POST /webhooks/metricas/{locationId}` | `x-api-key` | API key por cuenta o global |

Ambos endpoints comparten el mismo contrato de body.

## Campos del body

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `userId` | `string` | No | Email del asesor/closer en GHL. Atribuye la métrica al asesor. |
| `customerId` | `string` | No | ID del contacto/comprador en GHL. |
| `fecha` | `string` | No | Fecha `YYYY-MM-DD` o datetime ISO. Si no se envía, usa la fecha de hoy en la zona horaria de la cuenta. |
| `<nombre_metrica>` | `number` | Sí (al menos uno) | Cualquier campo numérico se guarda como métrica. El nombre debe coincidir con el `webhook_key` configurado en la cuenta. |

### Aliases de retrocompatibilidad (solo Cerebro)

| Alias | Se resuelve a |
|---|---|
| `asesor` | `userId` |
| `correo` | `userId` |

Prioridad: `userId` > `asesor` > `correo`. Usar siempre `userId` en nuevas integraciones.

## Curls canónicos (copy-paste para n8n)

### Recorridos agendados

```bash
curl -X POST "https://cerebro-tracker-v6-saas-git-cstkjl7bpa-ue.a.run.app/webhooks/metricas/{LOCATION_ID}" \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: {CRON_SECRET}" \
  -d '{
    "userId": "asesor@ejemplo.com",
    "customerId": "ghl_contact_id_123",
    "re_recorridos_agendados": 1
  }'
```

### Recorridos realizados

```bash
curl -X POST "https://cerebro-tracker-v6-saas-git-cstkjl7bpa-ue.a.run.app/webhooks/metricas/{LOCATION_ID}" \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: {CRON_SECRET}" \
  -d '{
    "userId": "asesor@ejemplo.com",
    "customerId": "ghl_contact_id_123",
    "re_recorridos_realizados": 1
  }'
```

### Apartados

```bash
curl -X POST "https://cerebro-tracker-v6-saas-git-cstkjl7bpa-ue.a.run.app/webhooks/metricas/{LOCATION_ID}" \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: {CRON_SECRET}" \
  -d '{
    "userId": "asesor@ejemplo.com",
    "customerId": "ghl_contact_id_123",
    "re_apartados": 1,
    "re_monto_apartados": 250000
  }'
```

### Llamada realizada (webhook)

```bash
curl -X POST "https://cerebro-tracker-v6-saas-git-cstkjl7bpa-ue.a.run.app/webhooks/metricas/{LOCATION_ID}" \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: {CRON_SECRET}" \
  -d '{
    "userId": "asesor@ejemplo.com",
    "customerId": "ghl_contact_id_123",
    "re_llamada_realizada": 1
  }'
```

### Descartado

```bash
curl -X POST "https://cerebro-tracker-v6-saas-git-cstkjl7bpa-ue.a.run.app/webhooks/metricas/{LOCATION_ID}" \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: {CRON_SECRET}" \
  -d '{
    "userId": "asesor@ejemplo.com",
    "customerId": "ghl_contact_id_123",
    "re_descartado": 1
  }'
```

### Múltiples métricas en un solo request

```bash
curl -X POST "https://cerebro-tracker-v6-saas-git-cstkjl7bpa-ue.a.run.app/webhooks/metricas/{LOCATION_ID}" \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: {CRON_SECRET}" \
  -d '{
    "userId": "asesor@ejemplo.com",
    "customerId": "ghl_contact_id_123",
    "fecha": "2026-07-28",
    "re_recorridos_agendados": 1,
    "re_apartados": 1,
    "re_monto_apartados": 350000
  }'
```

## Comportamiento

- Los valores son **acumulativos** cuando se atribuyen a un asesor (`userId`). Enviar `"re_apartados": 1` dos veces resulta en valor 2.
- Sin `userId`, el valor se **sobrescribe** (upsert por fecha + campo).
- Campos no numéricos en el body se ignoran silenciosamente.
- `userId`, `customerId`, `fecha`, `asesor` y `correo` son reservados y no se guardan como métricas.

## Métricas RE disponibles

| Webhook key | Descripción |
|---|---|
| `re_leads_nuevos` | Leads nuevos (semana) |
| `re_leads_mes` | Leads nuevos (mes) |
| `re_recorridos_agendados` | Tours agendados |
| `re_recorridos_realizados` | Tours completados |
| `re_recorridos_cancelados` | Tours cancelados/no-show |
| `re_apartados` | Propiedades apartadas |
| `re_monto_apartados` | Valor total de apartados |
| `re_comision_apartados` | Comisión sobre apartados |
| `re_comision_mensual` | Comisión mensual acumulada |
| `re_horas_capacitacion` | Horas de entrenamiento |
| `re_actividad_vencida` | Oportunidades sin seguimiento |
| `re_llamada_realizada` | Llamada realizada (webhook) |
| `re_descartado` | Lead descartado |

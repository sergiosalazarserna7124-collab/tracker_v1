# Endpoints para llamadas y metricas RE (Real Estate)

Documentacion para integracion via n8n / workflows externos.

**Base URL prod:** `https://cerebro-tracker-v6-saas-git-cstkjl7bpa-ue.a.run.app`

---

## 1. Llamada contestada (effective) — con categoria opcional

Cuando una llamada es contestada, se envia a uno de estos endpoints para que el Cerebro la transcriba, clasifique con IA y registre.

### Endpoints

| Canal | Ruta | Metodo |
|-------|------|--------|
| Twilio | `/webhooks/twilio/effective` | POST |
| GHL (sin Twilio) | `/webhooks/ghl/calls/effective` | POST |

### Payload

```json
{
  "contact_id": "abc123",
  "full_name": "Juan Perez",
  "phone": "+5215512345678",
  "location": { "id": "LOCATION_ID_GHL" },
  "customData": {
    "nombre": "Juan Perez",
    "email": "juan@example.com",
    "numero": "+5215512345678",
    "closermail": "asesor@empresa.com",
    "nombrecloser": "Max",
    "locationid": "LOCATION_ID_GHL",
    "transcript": "Speaker 1: Hola...",
    "categoria": "perfilamiento"
  }
}
```

### Campo `categoria` (AUT-1863)

**Nuevo.** Opcional. Si se envia, el Cerebro lo usa como **categoria autoritativa** para el analisis de la llamada (en lugar de que la IA la infiera).

- Acepta el **id** o el **nombre** de la categoria (case-insensitive para nombre).
- Las categorias validas son las configuradas en la cuenta (`categorias_llamadas` en la tabla `cuentas`).
- Si el valor no matchea ninguna categoria configurada, se ignora y la IA infiere normalmente.
- Si no se envia, el comportamiento es el actual (IA infiere la categoria).

**Ejemplo — por id:**
```json
{ "customData": { "categoria": "cat_perfilamiento_01", ... } }
```

**Ejemplo — por nombre:**
```json
{ "customData": { "categoria": "perfilamiento", ... } }
```

**Ejemplo — seguimiento:**
```json
{ "customData": { "categoria": "seguimiento", ... } }
```

### Formato n8n (envuelto)

Tambien se acepta el formato envuelto por n8n:
```json
[{ "body": { "contact_id": "...", "customData": { ... } } }]
```

---

## 2. Metricas RE (apartados, recorridos, descartes)

Para registrar metricas de real estate (apartados, recorridos agendados/realizados/cancelados, etc.) se usa el endpoint generico de metricas.

### Endpoint

| Ruta | Metodo | Auth |
|------|--------|------|
| `/webhooks/metricas/:locationid` | POST | Header `x-cron-secret` |

### Auth

Header requerido: `x-cron-secret: <CRON_SECRET>`

### Payload

El body acepta cualquier combinacion de campos numericos. Los campos se matchean contra las metricas configuradas en la cuenta por su `webhookCampo`.

**Campos RE estandarizados (AUT-1849):**

| Campo webhook | Metrica | Formato |
|---------------|---------|---------|
| `re_apartados` | Apartados | numero |
| `re_monto_apartados` | Monto apartados | moneda |
| `re_comision_apartados` | Comision por apartados | moneda |
| `re_recorridos_agendados` | Recorridos agendados | numero |
| `re_recorridos_realizados` | Recorridos realizados | numero |
| `re_recorridos_cancelados` | Recorridos cancelados | numero |
| `re_descartes` | Descartes | numero |
| `re_perfilamiento` | Perfilamiento | numero |

**Atribucion a asesor (AUT-1849):** Enviar `userId` (email del asesor) y `customerId` (email del comprador) en el body para atribuir la metrica.

```json
{
  "userId": "asesor@empresa.com",
  "customerId": "comprador@email.com",
  "re_apartados": 1,
  "re_monto_apartados": 350000,
  "re_recorridos_realizados": 2
}
```

### Ejemplo completo

```bash
curl -X POST \
  "https://cerebro-tracker-v6-saas-git-cstkjl7bpa-ue.a.run.app/webhooks/metricas/LOCATION_ID" \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: CRON_SECRET_AQUI" \
  -d '{
    "userId": "max@empresa.com",
    "customerId": "cliente@email.com",
    "re_perfilamiento": 1
  }'
```

### Respuesta

```json
{
  "success": true,
  "message": "Se guardaron 1 campo(s) para 2026-07-28",
  "campos_guardados": ["re_perfilamiento"],
  "fecha": "2026-07-28",
  "atribuido_a": "max@empresa.com"
}
```

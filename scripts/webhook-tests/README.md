# Pruebas de webhooks (capa branded `/lm/webhook/*`)

Prueba end-to-end de cada webhook contra una cuenta real. Cada payload lleva
datos inventados y un identificador estable (`WT_*`, `REASIGN_USER_1`, etc.) para
poder verificar en la BD qué fila quedó.

## Cuenta de prueba
- `id_cuenta = 1`, `locationid = "test"` (cuenta "juan").
- API key de prueba: `wht_test_key_123456` (tabla `api_keys_cuenta`).
- El webhook de métricas exige el header `x-cron-secret` = `CRON_SECRET`.

## Cómo correr
```bash
# Local (server con `npm run dev`, apunta a la MISMA Supabase de prod)
BASE_URL=http://localhost:8080 API_KEY=wht_test_key_123456 CRON_SECRET=xxx ./run.sh

# Producción (Render)
BASE_URL=https://tracker-v1-mhx6.onrender.com API_KEY=... CRON_SECRET=xxx ./run.sh
```

## Webhooks cubiertos

| # | Prueba | Endpoint | Tabla donde "llega" |
|---|--------|----------|---------------------|
| 1 | Llamada pendiente (setup) | `/lm/webhook/llamada/pending` | `registros_de_llamada` (estado `pdte`) |
| 2 | Llamada efectiva **con objeciones** | `/lm/webhook/llamada/effective` | `registros_de_llamada` (clasificación + `ia_objeciones` vía IA) |
| 3 | Llamada **no contestada** | `/lm/webhook/llamada/no-answer` | `registros_de_llamada` (estado `no_contestada`) |
| 4 | Videollamada efectiva (**Fathom**) | `/lm/webhook/videollamada/:id_cuenta` | `resumenes_diarios_agendas` (recording + link + resumen IA) |
| 5 | Recorrido **agendado** (cita) | `/lm/webhook/cita` | `resumenes_diarios_agendas` (categoría `PDTE`) |
| 6 | Videollamada **asistida** (vía GHL) | `/lm/webhook/asistencia/:id_cuenta` | `resumenes_diarios_agendas` (marca asistencia) |
| 7 | **Contacto** creado | `/lm/webhook/contacto` | `mapeo_id_externo` (crea contacto en GHL — requiere token GHL real) |
| 8 | **Reasignación** de asesor | `/lm/webhook/reasignacion` | `registros_de_llamada` / `log_llamadas` / `chats_logs` (closer) |
| 9 | Lead **descartado** | `/lm/webhook/calificacion/:locationid` | `registros_de_llamada` (`calificacion_manual='descartado'`, `excluido_metricas=true`) |
| 10 | Recorridos / **apartados** / **ventas** | `/lm/webhook/metricas/:locationid` | `metricas_webhook` (una fila por asesor + una agregada) |

## Dependencias externas (no bloquean la recepción del webhook)
- **IA (OpenAI)**: la clasificación de llamada efectiva, la extracción de
  objeciones y el resumen de videollamada requieren una `OPENAI_API_KEY` real.
  Con el placeholder actual el webhook igual se recibe y crea la fila, pero sin
  esos campos de IA.
- **Token GHL**: el webhook de contacto (crear nuevo) y las notas/tags en GHL
  requieren el `token_ghl` real de la cuenta. La cuenta de prueba usa `"test"`.

## Bugs encontrados y corregidos durante estas pruebas
1. `src/services/webhooks/calificacion.service.ts`: comparaba
   `registros_de_llamada.id_cuenta` (integer) con `$1::text` → error
   `operator does not exist: integer = text`, que hacía fallar (500) **todo** el
   webhook de descarte. Corregido.
2. `metricas_webhook`: faltaban los índices únicos que exige el `ON CONFLICT`
   del upsert (`(id_cuenta,fecha,campo,ghl_user_id)` y el parcial
   `(id_cuenta,fecha,campo) WHERE ghl_user_id IS NULL`). El baseline-seed había
   saltado la migración 044, dejando en su lugar un único índice de 3 columnas.
   Esto hacía fallar (500) **todo** el webhook de métricas. Corregido en la BD y
   en `db/init_schema.sql`.

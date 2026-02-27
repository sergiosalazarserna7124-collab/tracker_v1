# 🧠 Cerebro — Tracker V6 SaaS Backend

> Backend headless y stateless multi-tenant para tracking de citas, llamadas telefónicas y videollamadas.  
> Integra **GoHighLevel**, **Twilio** y **Fathom** con **IA** (GPT-4o-mini + Whisper) y centraliza todo en **PostgreSQL**.

---

## Tabla de Contenidos

- [¿Qué hace este sistema?](#qué-hace-este-sistema)
- [Stack Tecnológico](#stack-tecnológico)
- [Instalación y Primeros Pasos](#instalación-y-primeros-pasos)
- [Variables de Entorno](#variables-de-entorno)
- [Configuración de Cuentas en la BD (`public.cuentas`)](#configuración-de-cuentas-en-la-bd)
- [Endpoints](#endpoints)
  - [GET /health](#get-health)
  - [POST /webhooks/ghl — Citas GHL](#post-webhooksghl--citas-ghl)
  - [POST /webhooks/twilio — Llamada pendiente](#post-webhookstwilio--llamada-pendiente)
  - [POST /webhooks/twilio/no-answer — Llamada no contestada](#post-webhookstwiiliono-answer--llamada-no-contestada)
  - [POST /webhooks/twilio/effective — Llamada efectiva](#post-webhookstwilioeffective--llamada-efectiva)
  - [POST /webhooks/fathom/:id_cuenta — Videollamada](#post-webhooksfathomid_cuenta--videollamada)
  - [POST /cron/update-no-shows — Cron No-Shows](#post-cronupdate-no-shows--cron-no-shows)
- [Esquema de Base de Datos](#esquema-de-base-de-datos)
- [Tags y Notas GHL](#tags-y-notas-ghl)
- [Resiliencia y Cloud Run](#resiliencia-y-cloud-run)
- [Despliegue en Google Cloud Run](#despliegue-en-google-cloud-run)
- [Estructura del Proyecto](#estructura-del-proyecto)

---

## ¿Qué hace este sistema?

Este backend es el **"Cerebro"** central de un SaaS multi-tenant de ventas. Cada cliente (tenant) tiene su propia cuenta en la BD, y el sistema procesa tres tipos de eventos de forma automática:

| Fuente | Evento | Lo que hace el Cerebro |
|---|---|---|
| **GoHighLevel** | Cita agendada / cancelada / reagendada | Registra en BD + aplica tag en CRM |
| **GHL + Twilio** | Llamada pendiente / no contestada / efectiva | Registra en BD, transcribe audio con Whisper, clasifica con IA, aplica tag + notas en CRM, registra evento en historial |
| **Fathom** | Videollamada grabada | Analiza transcripción con 4 IAs en paralelo, hace upsert en BD, aplica tag + notas en CRM |
| **Cron Job** | Diario (tu scheduler externo) | Marca como `no_show` todas las citas pendientes sin videollamada ese día |

> **Los eventos llegan directamente** desde GHL, Fathom o Twilio como objetos JSON planos.  
> El backend también acepta el formato legado de n8n `[{ body: { ... } }]` de forma automática, sin configuración adicional.

---

## Stack Tecnológico

| Tecnología | Uso |
|---|---|
| **Node.js 22 LTS** | Runtime |
| **Fastify v5** | Framework HTTP (webhooks de alta velocidad) |
| **TypeScript 5 (ESM)** | Tipado estático |
| **TypeBox** | Validación de payloads (JSON Schema nativo de Fastify) |
| **Drizzle ORM** | Queries tipadas a PostgreSQL |
| **PostgreSQL** | Base de datos externa (ya alojada) |
| **Vercel AI SDK** (`ai` + `@ai-sdk/openai`) | GPT-4o-mini para análisis de llamadas y citas |
| **OpenAI SDK** (`openai`) | Whisper para transcripción de audio de llamadas |
| **Google Cloud Run** | Deploy (Dockerfile multi-stage, puerto 8080) |
| **pnpm** | Package manager |

---

## Instalación y Primeros Pasos

```bash
# 1. Instalar dependencias
pnpm install

# 2. Configurar variables de entorno
cp .env.example .env
# → Editar .env con tus credenciales reales (ver sección siguiente)

# 3. Desarrollo con hot-reload
pnpm dev

# 4. Verificar que levantó
curl http://localhost:8080/health
```

**Otros comandos:**

```bash
pnpm build        # Compilar TypeScript → dist/
pnpm start        # Producción (requiere haber ejecutado build primero)
pnpm typecheck    # Verificar tipos sin compilar
```

---

## Variables de Entorno

Copia `.env.example` a `.env` y rellena cada valor:

```env
PORT=8080
NODE_ENV=development
DATABASE_URL=postgresql://user:password@host:5432/nombre_bd
CRON_SECRET=una_clave_secreta_larga_y_aleatoria
OPENAI_API_KEY=sk-...
```

### ¿De dónde saco cada valor?

| Variable | Dónde obtenerla |
|---|---|
| `PORT` | Siempre `8080` para Cloud Run. En local puedes usar cualquier puerto. |
| `NODE_ENV` | `development` en local, `production` en Cloud Run. |
| `DATABASE_URL` | Tu proveedor de PostgreSQL (Supabase, Neon, Railway, etc.). Formato: `postgresql://usuario:contraseña@host:puerto/nombre_base_de_datos` |
| `CRON_SECRET` | **Tú lo generas.** Cualquier string largo y aleatorio. Ej: `openssl rand -hex 32` en terminal. Este mismo valor va en el header `x-cron-secret` cuando llamas al cron. |
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com) → API Keys → Create new secret key |

---

## Configuración de Cuentas en la BD

> Esta es la tabla maestra que conecta cada cliente (tenant) con sus credenciales externas.  
> **Debes llenarla manualmente en PostgreSQL** antes de que los webhooks funcionen para ese cliente.

**Tabla: `public.cuentas`**

| Columna | Descripción | ¿Dónde obtenerlo? |
|---|---|---|
| `id_cuenta` | PK autoincremental. El sistema lo usa internamente. | Auto-generado por la BD |
| `nombre_cuenta` | Nombre descriptivo del cliente/tenant. | Tú lo defines |
| `locationid` | Location ID del sub-account del cliente en GHL. **Debe ser exacto** — el sistema busca con `WHERE locationid = ?` | En GHL: Settings → Business Info → Location ID (o en la URL del sub-account) |
| `token_ghl` | API Key de GHL. Se puede guardar con o sin el prefijo `Bearer ` — el sistema lo normaliza automáticamente. | En GHL: Settings → API Keys → Create new key |
| `prompt_ventas` | Prompt personalizado para el análisis forense de Fathom. Si es `NULL`, se usa un prompt genérico. | Tú lo redactas (instrucciones para la IA sobre cómo calificar leads de ese cliente) |
| `twilio_sid` | Account SID de Twilio. Formato `AC...` | En [Twilio Console](https://console.twilio.com) → Dashboard → Account Info |
| `auth_twilio` | Auth Token de Twilio | En [Twilio Console](https://console.twilio.com) → Dashboard → Account Info (al lado del SID) |

### Ejemplo de INSERT para agregar un cliente:

```sql
INSERT INTO public.cuentas (nombre_cuenta, locationid, token_ghl, twilio_sid, auth_twilio)
VALUES (
  'Shark Realtors',
  'gpquUsStA2ZEri53oPgc',
  'pit-abc123def456...',
  'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  'tu_auth_token_de_twilio'
);
```

---

## Endpoints

> ### 🔌 Compatibilidad de formatos de payload
>
> El Cerebro acepta **ambos formatos** en todos los endpoints de webhook, de forma automática y transparente:
>
> | Formato | Descripción | Ejemplo |
> |---|---|---|
> | **Directo** | El origen envía el JSON tal cual | `{ "contact_id": "...", "customData": { ... } }` |
> | **n8n (legado)** | Envuelto en array por n8n | `[{ "body": { "contact_id": "...", "customData": { ... } } }]` |
>
> La función `extractWebhookBody()` en `src/utils/payload.utils.ts` detecta automáticamente cuál formato llegó y normaliza el payload antes de procesarlo.

---

### `GET /health`

Verifica que el servidor esté vivo. Úsalo como health check en Cloud Run.

**Respuesta:**
```json
{
  "status": "ok",
  "timestamp": "2026-02-23T21:00:00.000Z",
  "uptime": 42.3
}
```

---

### `POST /webhooks/ghl` — Citas GHL

Recibe eventos de citas desde GoHighLevel. Procesa tres tipos de eventos según `customData.categoria`.

#### ¿Qué hace con cada categoría?

| `customData.categoria` | Acción en BD | Tag GHL | Estado en BD |
|---|---|---|---|
| `pendiente` | INSERT nuevo registro | `pdteautoia` | `PDTE` |
| `cancelada` | Busca registro → UPDATE. Si no existe → INSERT | `canceladaautoia` | `CANCELADA` |
| `reagenda` | Busca registro → UPDATE (+ nueva fecha). Si no existe → INSERT | `reagendadoautoia` | `PDTE` |

#### ¿Cómo busca el registro existente?
1. Primero busca por `idcliente + id_cuenta`
2. Si no encuentra → fallback por `email_lead + id_cuenta`
3. Si no encuentra con ninguno → crea registro nuevo

#### ¿Cómo se normaliza la fecha de la reunión?
El campo `customData.hora` acepta dos formatos:
- Español: `"23 de febrero de 2026 8:00"`
- Inglés: `"February 27, 2026 3:00 PM"`

Se combina con `customData.zonahoraria` (formato IANA, ej: `"America/Bogota"`, case-insensitive) y se convierte a UTC.

---

### `POST /webhooks/twilio` — Llamada pendiente

Registra el lead en BD con estado `pdte` y lo registra en el historial (`log_llamadas`).

**Respuesta:**
```json
{
  "success": true,
  "message": "Call event registered",
  "data": { "id_registro": 3808 }
}
```

---

### `POST /webhooks/twilio/no-answer` — Llamada no contestada

GHL avisa que la llamada no fue contestada. El sistema busca un registro activo del lead y lo actualiza; si no existe, crea uno nuevo.

**Lógica interna:**

```
1. Busca registro activo:
   WHERE mail_lead = email AND id_cuenta = ?
   AND (estado IN ('pdte','seguimiento','programado','no_contestada','no_contestado') OR estado IS NULL)
   ORDER BY fecha_evento DESC LIMIT 1

2a. Si EXISTE → UPDATE:
    estado = 'seguimiento', intentos_contacto = anterior + 1

2b. Si NO EXISTE → INSERT:
    estado = 'seguimiento', intentos_contacto = 1

3. Tag GHL: 'no_contestallamadaautoia'
4. Nota GHL: "Llamada no contestada"
5. Registra evento en log_llamadas (tipo_evento = 'no_contesto')
```

---

### `POST /webhooks/twilio/effective` — Llamada efectiva

El pipeline más complejo del sistema. Responde `200 OK` inmediato y procesa en segundo plano.

#### Flujo completo

```
Llega payload
     │
     ▼
[1] Resolve Account (con retry automático)
    Busca en public.cuentas por locationid
    → Obtiene: token_ghl, twilio_sid, auth_twilio
     │
     ▼ (si falta twilio_sid o teléfono → CAMINO A)
     │
[2] Pipeline Twilio (timeout 30s, Basic Auth)
    GET /Calls.json?To={phone}&Status=completed&PageSize=1
    → callSid + parentCallSid
     │
    GET /Calls/{callSid}/Recordings.json (polling con backoff)
    → Si vacío: espera 4s, reintenta
    → Si sigue vacío: espera 8s, reintenta
    → Si hay parentCallSid: prueba ese también en cada intento
    → recordingSid
     │
    GET /Recordings/{recordingSid}.mp3
    → buffer de audio (si < 5KB → CAMINO A)
     │
     ▼ (si falla cualquier paso → CAMINO A)
     │
[3] Whisper (OpenAI)
    Transcribe el audio a texto
     │
     ▼ (si falla o vacío → CAMINO A)
     │
[4] GPT-4o-mini (temperature: 0)
    Clasifica: buzon (bool|null), estado, iadesc
     │
     ├── buzon = true o null → CAMINO A
     │
     └── buzon = false → CAMINO B
```

#### Camino A — followUpPath (sin contestar / buzón / error)

- Busca registro activo → UPDATE `estado=seguimiento`, `intentos+1`
- Si no existe → INSERT con `estado=seguimiento`
- Tag GHL: `no_contestallamadaautoia`
- Nota GHL: `"Llamada no contestada"`
- Log: `tipo_evento = 'buzon'` o `'no_contesto'`

#### Camino B — effectivePath (persona contestó)

- Busca el registro **más reciente** por `mail_lead + id_cuenta` (sin filtro de estado)
- Si existe Y estado es activo → **UPDATE** con datos de IA
- Si no existe O estado es `interesado`/`no_interesado` → **INSERT** nuevo registro
- Tag GHL dinámico según estado IA
- Notas GHL:
  - `📞 Llamada Telefónica — Análisis IA` (descripción de la IA)
  - `📞 Llamada Telefónica — Transcripción` (texto completo de Whisper)
- Log: `tipo_evento = 'efectiva_{estado}'`

#### Estados activos (se actualiza el registro existente)

| Estado anterior | ¿Se actualiza? | Razón |
|---|---|---|
| `pdte` | ✅ Sí | Esperando resultado |
| `seguimiento` | ✅ Sí | Sin desenlace aún |
| `programado` | ✅ Sí | Pidió que llamaran después, sin desenlace |
| `no_contestada` / `no_contestado` | ✅ Sí | Sin desenlace |
| `null` / vacío | ✅ Sí | Estado desconocido |
| `interesado` | ❌ No → INSERT nuevo | Ya tiene desenlace comercial |
| `no_interesado` | ❌ No → INSERT nuevo | Ya tiene desenlace comercial |

#### Tags dinámicos según clasificación IA

| Estado IA | Tag GHL |
|---|---|
| `interesado` | `interesadollamadaautoia` |
| `programado` | `programadollamadaautoia` |
| `no_interesado` | `no_interesadollamadaautoia` |
| `seguimiento` | `seguimientollamadaautoia` |

#### `speed_to_lead` (cálculo automático)

Cuando un registro pasa de `pdte` a cualquier otro estado, el sistema calcula automáticamente los **minutos** transcurridos desde `fecha_evento` hasta el momento actual y lo guarda en `speed_to_lead` (tipo TEXT). Ejemplo: si la llamada se creó como pendiente a las 15:00 y se resuelve a las 15:06, `speed_to_lead = "6"`.

---

### `POST /webhooks/fathom/:id_cuenta` — Videollamada

Recibe la grabación y transcripción de una videollamada de Fathom. El `:id_cuenta` en la URL identifica el tenant.

**Límite de payload:** 10 MB.  
**Responde `200 OK` inmediato.** Procesamiento en segundo plano.

#### Flujo de procesamiento (6 fases)

```
[Fase 1] Data Prep
  Extrae: closerEmail, closerName, shareUrl, transcript formateado
  Identifica email_lead desde calendar_invitees (is_external=true)

[Fase 2] DB Fetch
  SELECT token_ghl, locationid, prompt_ventas FROM cuentas

[Fase 3] GHL Fetch
  Busca contacto por email → contactId, contactName, assignedUserId
  Si hay assignedUserId → obtiene email del closer asignado

[Fase 4] Motor IA — 4 llamadas GPT-4o-mini en PARALELO (Promise.allSettled)
  1. Clasificador comercial → categoria + cash_collected + facturacion
  2. Análisis forense → resumen_ia (usa prompt_ventas o prompt genérico)
  3. Lead Report 6 puntos → reportmarketing
  4. Extractor de objeciones → objeciones_ia (array JSON)

[Fase 5] Sync Final
  5a. Tag GHL según categoría IA (cerradaautoia / ofertadaautoia / noofertadaautoia)
  5b. UPSERT en resumenes_diarios_agendas

[Fase 6] Notas GHL
  🎥 Videollamada — Análisis IA (categoría + montos + análisis forense)
  🎥 Videollamada — Transcripción (texto completo formateado)
```

---

### `POST /cron/update-no-shows` — Cron No-Shows

Endpoint interno para tu scheduler. Marca masivamente como `no_show` las citas `PDTE` y aplica tag `noshowautoia` en GHL.

#### Headers requeridos

| Header | Valor |
|---|---|
| `x-cron-secret` | Debe coincidir con `CRON_SECRET` de tu `.env` |
| `Content-Type` | `application/json` |

#### Body

```json
{
  "event": "daily-no-show-check",
  "target_date": "2026-02-23",
  "account_ids": [1, 2, 5]
}
```

Rate limiting: lotes de 10 requests con 500ms de pausa para respetar rate limits de GHL.

---

## Esquema de Base de Datos

### `resumenes_diarios_agendas` — Citas y videollamadas

| Columna | Tipo | Descripción |
|---|---|---|
| `id_registro_agenda` | serial PK | Autoincremental |
| `id_cuenta` | integer NOT NULL | Tenant ID |
| `idcliente` | text | ID único del lead en el sistema del cliente |
| `ghl_contact_id` | text | Contact ID en GoHighLevel |
| `fecha` | timestamptz | Momento de procesamiento (UTC) |
| `nombre_de_lead` | text | Nombre del prospecto |
| `origen` | text | Campaña/fuente / utmContent |
| `email_lead` | text | Email del lead |
| `categoria` | text | `PDTE`, `CANCELADA`, `no_show`, `Cerrada`, `Ofertada`, `No_Ofertada` |
| `closer` | text | Asesor asignado |
| `tags` | text | Tags separados por coma |
| `fecha_reunion` | timestamptz | Fecha/hora de la cita en UTC |
| `cash_collected` | text | Monto cobrado (string numérico) |
| `facturacion` | text | Valor total del acuerdo |
| `resumen_ia` | text | Análisis forense en Markdown |
| `link_llamada` | text | URL de la grabación en Fathom |
| `objeciones_ia` | jsonb | Array de `{objecion, categoria}` |
| `reportmarketing` | text | Lead Report 6 puntos |

---

### `registros_de_llamada` — Estado actual de llamadas telefónicas

> Tabla "viva": siempre refleja el **estado actual** del lead en el ciclo de llamadas.

| Columna | Tipo | Descripción |
|---|---|---|
| `id_registro` | serial PK | Autoincremental |
| `fecha_evento` | timestamptz | Momento de recepción del webhook (UTC) |
| `id_cuenta` | integer | FK a cuentas |
| `nombre_lead` | text | Nombre del prospecto |
| `estado` | text | `pdte` → `seguimiento` / `programado` → `interesado` / `no_interesado` |
| `mail_lead` | text | Email o contact_id del lead |
| `phone_raw_format` | text | Teléfono sin normalizar |
| `creativo_origen` | text | UTM/creativo de origen |
| `closer_mail` | text | Email del asesor |
| `nombre_closer` | text | Nombre del asesor |
| `fecha_y_hora_de_seguimiento` | timestamptz | Último seguimiento (UTC) |
| `speed_to_lead` | text | Minutos desde `pdte` hasta cambio de estado (cálculo automático) |
| `intentos_contacto` | integer | Intentos acumulados |
| `fecha_primera_llamada` | timestamptz | Primera llamada registrada (UTC) |
| `trancription` | text | Transcripción Whisper |
| `callsid` | text | SID de la llamada en Twilio |
| `iadescripcion` | text | Análisis IA de la llamada |
| `id_user_ghl` | text | ID del contacto en GHL (llega como `customData.id_customer_ghl`) |

---

### `log_llamadas` — Historial inmutable de eventos

> **Tabla de auditoría.** Cada interacción telefónica genera una fila. Nunca se edita, solo se inserta. Es el audit trail completo para el dashboard.

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | bigserial PK | Autoincremental |
| `id_registro` | integer | FK a `registros_de_llamada` (el registro "vivo") |
| `id_cuenta` | integer NOT NULL | Tenant |
| `mail_lead` | text | Email/ID del lead (denormalizado para búsqueda) |
| `id_user_ghl` | text | ID GHL del lead |
| `contact_id_ghl` | text | Contact ID GHL |
| `nombre_lead` | text | Nombre |
| `phone` | text | Teléfono |
| `tipo_evento` | text NOT NULL | Ver tabla abajo |
| `estado_resultado` | text | Estado que quedó en `registros_de_llamada` |
| `call_sid` | text | SID de Twilio |
| `transcripcion` | text | Texto completo de Whisper |
| `ia_descripcion` | text | Análisis de la IA |
| `closer_mail` | text | Email del closer |
| `nombre_closer` | text | Nombre del closer |
| `creativo_origen` | text | UTM/creativo |
| `speed_to_lead` | text | Minutos desde pdte |
| `ts` | timestamptz | Timestamp del evento (UTC, default now) |

#### Tipos de evento registrados

| `tipo_evento` | Cuándo se genera |
|---|---|
| `pdte` | Se crea la llamada pendiente |
| `no_contesto` | GHL reportó no-answer, o el pipeline Twilio falló |
| `buzon` | La IA detectó buzón de voz |
| `efectiva_seguimiento` | Contestó pero sin resultado comercial claro |
| `efectiva_interesado` | Contestó y mostró interés |
| `efectiva_programado` | Contestó pero pidió que llamen después |
| `efectiva_no_interesado` | Contestó y rechazó |

#### Queries útiles para el dashboard

**Historial completo de un lead:**
```sql
SELECT tipo_evento, estado_resultado, ia_descripcion, ts, closer_mail
FROM log_llamadas
WHERE (mail_lead = 'x@email.com' OR id_user_ghl = 'GHL_ID')
  AND id_cuenta = 3
ORDER BY ts DESC;
```

**Eventos de un día (filtro de calendario):**
```sql
SELECT * FROM log_llamadas
WHERE id_cuenta = 3
  AND DATE(ts AT TIME ZONE 'America/Bogota') = '2026-02-27'
ORDER BY ts DESC;
```

**Métricas del día:**
```sql
SELECT tipo_evento, COUNT(*) AS total,
       COUNT(DISTINCT COALESCE(mail_lead, id_user_ghl)) AS leads_unicos
FROM log_llamadas
WHERE id_cuenta = 3
  AND ts >= date_trunc('day', NOW() AT TIME ZONE 'America/Bogota' AT TIME ZONE 'UTC')
GROUP BY tipo_evento;
```

**Tasa de contacto últimos 30 días:**
```sql
SELECT DATE(ts AT TIME ZONE 'America/Bogota') AS dia,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE tipo_evento LIKE 'efectiva_%') AS contactadas,
       COUNT(*) FILTER (WHERE tipo_evento IN ('buzon','no_contesto')) AS no_contestaron,
       ROUND(100.0 * COUNT(*) FILTER (WHERE tipo_evento LIKE 'efectiva_%') / NULLIF(COUNT(*),0), 1) AS tasa_pct
FROM log_llamadas
WHERE id_cuenta = 3 AND ts >= NOW() - INTERVAL '30 days'
GROUP BY dia ORDER BY dia DESC;
```

#### Índices

```sql
CREATE INDEX idx_log_id_cuenta_ts ON log_llamadas (id_cuenta, ts DESC);
CREATE INDEX idx_log_mail_lead ON log_llamadas (mail_lead, ts DESC);
CREATE INDEX idx_log_id_user_ghl ON log_llamadas (id_user_ghl, ts DESC);
CREATE INDEX idx_log_tipo_evento ON log_llamadas (id_cuenta, tipo_evento, ts DESC);
CREATE INDEX idx_log_fecha_dia ON log_llamadas (id_cuenta, DATE(ts AT TIME ZONE 'UTC') DESC);
CREATE INDEX idx_log_id_registro ON log_llamadas (id_registro);
```

---

### `public.cuentas` — Tabla de tenants/clientes

> Ver sección [Configuración de Cuentas](#configuración-de-cuentas-en-la-bd).

---

## Tags y Notas GHL

### Tags aplicados automáticamente

| Evento | Tag GHL |
|---|---|
| Cita pendiente | `pdteautoia` |
| Cita cancelada | `canceladaautoia` |
| Cita reagendada | `reagendadoautoia` |
| No-show (cron) | `noshowautoia` |
| Videollamada cerrada | `cerradaautoia` |
| Videollamada ofertada | `ofertadaautoia` |
| Videollamada no ofertada | `noofertadaautoia` |
| Llamada no contestada / buzón / error pipeline | `no_contestallamadaautoia` |
| Llamada efectiva → interesado | `interesadollamadaautoia` |
| Llamada efectiva → programado | `programadollamadaautoia` |
| Llamada efectiva → no interesado | `no_interesadollamadaautoia` |
| Llamada efectiva → seguimiento | `seguimientollamadaautoia` |

### Notas GHL

| Evento | Nota |
|---|---|
| Llamada no contestada / buzón / error | `Llamada no contestada` |
| Llamada efectiva (persona contestó) | `📞 Llamada Telefónica — Análisis IA` + `📞 Llamada Telefónica — Transcripción` |
| Videollamada Fathom | `🎥 Videollamada — Análisis IA` + `🎥 Videollamada — Transcripción` |

---

## Resiliencia y Cloud Run

El sistema está diseñado para funcionar de forma robusta en Cloud Run, donde las instancias pueden escalar a 0 y las conexiones de red son efímeras.

### Retry automático para base de datos

Todas las operaciones de BD están envueltas con `withRetry()` que:
- Reintenta hasta **3 veces** con backoff lineal (1s, 2s)
- Solo reintenta errores de **conexión** (`Connection terminated`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`)
- Recorre la cadena `err → err.cause` para detectar errores envueltos por Drizzle ORM
- Errores lógicos (constraint violation, syntax error) se propagan inmediatamente

### Pool de PostgreSQL

- `connectionTimeoutMillis: 10_000` (10s para cold-starts)
- `keepAlive: true` + `keepAliveInitialDelayMillis: 10_000` (detecta conexiones TCP muertas)
- `max: 5` (evita saturar la BD con múltiples instancias)
- `pool.on('error')` captura errores de fondo sin crashear el proceso

### Twilio API

- Timeout de 30s para llamadas de metadata (DNS frío en cold-start)
- Timeout de 90s para descarga de audio
- Polling con backoff para recordings: intento inmediato → 4s → 8s (Twilio puede tardar en publicar la grabación)
- Fallback a `parentCallSid` cuando el recording está en el parent call (arquitectura de conferencia de GHL)

### Procesamiento asíncrono

Los endpoints `/webhooks/twilio/effective` y `/webhooks/fathom/:id_cuenta` responden `200 OK` inmediato y procesan en segundo plano para evitar timeouts del caller.

---

## Despliegue en Google Cloud Run

El proyecto incluye un `Dockerfile` multi-stage optimizado con imagen distroless.

```bash
# 1. Build de la imagen
docker build -t cerebro-tracker .

# 2. Tag y push a Artifact Registry
docker tag cerebro-tracker gcr.io/TU_PROYECTO/cerebro-tracker
docker push gcr.io/TU_PROYECTO/cerebro-tracker

# 3. Deploy en Cloud Run
gcloud run deploy cerebro-tracker \
  --image gcr.io/TU_PROYECTO/cerebro-tracker \
  --platform managed \
  --region us-central1 \
  --port 8080 \
  --set-env-vars DATABASE_URL=...,OPENAI_API_KEY=...,CRON_SECRET=...,NODE_ENV=production
```

---

## Estructura del Proyecto

```
src/
├── server.ts                          # Entry point — levanta Fastify en 0.0.0.0:8080
├── app.ts                             # buildApp() — instancia Fastify + registra rutas
│
├── config/
│   ├── env.ts                         # Valida variables de entorno al arrancar (fail-fast)
│   ├── database.ts                    # Pool PostgreSQL (pg) con keepAlive + error handler
│   └── drizzle.ts                     # Instancia Drizzle ORM sobre el pool
│
├── db/
│   └── schema.ts                      # Tablas: agendas, llamadas, logLlamadas, cuentas
│
├── plugins/
│   └── error-handler.ts               # Error handler global + 404 para Fastify
│
├── routes/
│   ├── health.route.ts                # GET /health
│   ├── webhooks/
│   │   ├── ghl.route.ts               # POST /webhooks/ghl
│   │   ├── fathom.route.ts            # POST /webhooks/fathom/:id_cuenta (10MB)
│   │   └── twilio.route.ts            # POST /webhooks/twilio + /no-answer + /effective
│   └── cron/
│       └── daily-tasks.route.ts       # POST /cron/update-no-shows
│
├── controllers/
│   ├── webhooks/
│   │   ├── ghl.controller.ts          # Usa extractWebhookBody → llama ghl.service
│   │   ├── fathom.controller.ts       # Responde 200 inmediato → async
│   │   └── twilio.controller.ts       # 3 handlers: pdte / no-answer / effective (async)
│   └── cron/
│       └── daily-tasks.controller.ts  # Verifica x-cron-secret → 401 si falla
│
├── services/
│   ├── ghl-api.service.ts             # GHL HTTP API: tags, notas, búsqueda de contactos
│   ├── twilio-api.service.ts          # Twilio REST: calls, recordings (polling), download
│   ├── webhooks/
│   │   ├── ghl.service.ts             # Dispatcher: pendiente / cancelada / reagenda
│   │   ├── fathom.service.ts          # 6 fases + upsert + notas GHL
│   │   └── twilio.service.ts          # pdte, followUpPath, effectivePath + log_llamadas
│   ├── ai/
│   │   ├── call-analysis.service.ts   # 4 IAs en paralelo para Fathom
│   │   └── call-classification.service.ts  # Whisper + GPT-4o-mini para llamadas
│   └── cron/
│       └── daily-tasks.service.ts     # Batch no-show + GHL tagging con rate limit
│
├── schemas/
│   ├── webhooks/
│   │   ├── ghl.schema.ts
│   │   ├── fathom.schema.ts
│   │   └── twilio.schema.ts
│   └── cron/
│       └── daily-tasks.schema.ts
│
├── types/
│   └── index.ts                       # ServiceResult y tipos compartidos
│
└── utils/
    ├── payload.utils.ts               # extractWebhookBody — formato directo vs n8n
    ├── date.utils.ts                  # Parsea fechas español/inglés + IANA timezone → UTC
    ├── retry.utils.ts                 # withRetry — retry con backoff para errores de conexión
    ├── batch.utils.ts                 # processInChunks — rate limiting para APIs externas
    └── fetch.utils.ts                 # fetchWithTimeout — fetch con AbortController
```

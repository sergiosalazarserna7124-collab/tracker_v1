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
- [Tags GHL Implementados](#tags-ghl-implementados)
- [Despliegue en Google Cloud Run](#despliegue-en-google-cloud-run)
- [Estructura del Proyecto](#estructura-del-proyecto)

---

## ¿Qué hace este sistema?

Este backend es el **"Cerebro"** central de un SaaS multi-tenant de ventas. Cada cliente (tenant) tiene su propia cuenta en la BD, y el sistema procesa tres tipos de eventos de forma automática:

| Fuente | Evento | Lo que hace el Cerebro |
|---|---|---|
| **GoHighLevel** | Cita agendada / cancelada / reagendada | Registra en BD + aplica tag en CRM |
| **GHL + Twilio** | Llamada pendiente / no contestada / efectiva | Registra en BD, transcribe audio con Whisper, clasifica con IA, aplica tag en CRM |
| **Fathom** | Videollamada grabada | Analiza transcripción con 4 IAs en paralelo, hace upsert en BD, aplica tag en CRM |
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
| `token_ghl` | API Key de GHL **incluyendo el prefijo `Bearer `**. Ej: `Bearer pit-abc123...` | En GHL: Settings → API Keys → Create new key. Agrega `Bearer ` adelante al guardarlo en BD. |
| `prompt_ventas` | Prompt personalizado para el análisis forense de Fathom. Si es `NULL`, se usa un prompt genérico. | Tú lo redactas (instrucciones para la IA sobre cómo calificar leads de ese cliente) |
| `twilio_sid` | Account SID de Twilio. Formato `AC...` | En [Twilio Console](https://console.twilio.com) → Dashboard → Account Info |
| `auth_twilio` | Auth Token de Twilio | En [Twilio Console](https://console.twilio.com) → Dashboard → Account Info (al lado del SID) |

### Ejemplo de INSERT para agregar un cliente:

```sql
INSERT INTO public.cuentas (nombre_cuenta, locationid, token_ghl, twilio_sid, auth_twilio)
VALUES (
  'Shark Realtors',
  'gpquUsStA2ZEri53oPgc',
  'Bearer pit-abc123def456...',
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
> La función `extractWebhookBody()` en `src/utils/payload.utils.ts` detecta automáticamente cuál formato llegó y normaliza el payload antes de procesarlo. No necesitas cambiar nada en GHL, Twilio o Fathom si ya tienes webhooks configurados.

---

### `GET /health`

Verifica que el servidor esté vivo. Úsalo como health check en Cloud Run.

**URL de ejemplo:** `https://tu-dominio.run.app/health`

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

Recibe eventos de citas desde GoHighLevel (directo o vía n8n). Procesa tres tipos de eventos según `customData.categoria`.

**URL que configuras en n8n:** `https://tu-dominio.run.app/webhooks/ghl`

#### ¿Qué hace con cada categoría?

| `customData.categoria` | Acción en BD | Tag que aplica en GHL | Estado en BD |
|---|---|---|---|
| `pendiente` | INSERT nuevo registro | `pdteautoia` | `PDTE` |
| `cancelada` | Busca registro → UPDATE. Si no existe → INSERT | `canceladaautoia` | `CANCELADA` |
| `reagenda` | Busca registro → UPDATE (+ nueva fecha). Si no existe → INSERT | `reagendadoautoia` | `PDTE` |
| cualquier otra | No hace nada (responde 200 OK) | — | — |

#### ¿Cómo busca el registro existente (para cancelada/reagenda)?
1. Primero busca por `idcliente + id_cuenta` (más preciso)
2. Si no encuentra → fallback por `email_lead + id_cuenta`
3. Si no encuentra con ninguno → crea registro nuevo

#### ¿Cómo se normaliza la fecha de la reunión?
El campo `customData.hora` viene en formato texto español (ej: `"23 de febrero de 2026 8:00"`) y `customData.zonahoraria` en formato IANA (ej: `"America/Bogota"`). El sistema los combina y convierte a UTC antes de guardar.

#### ¿De dónde saca el token para taggear en GHL?
Busca el `locationid` del payload en `public.cuentas` (match exacto) y usa el `token_ghl` de esa fila.

**Payload de ejemplo:**
```json
[
  {
    "body": {
      "first_name": "Jose",
      "email": "jose@example.com",
      "contact_id": "aGazvs90g4GBWeN9bcTA",
      "locationid": "cDE8vxa8PWC3FnUXT96M",
      "customData": {
        "categoria": "pendiente",
        "idcuenta": "2",
        "idcliente": "ISC23421ASCA",
        "nombre": "Jose",
        "closer": "Feli Collar",
        "origen": "#1 creativo",
        "hora": "23 de febrero de 2026 8:00",
        "zonahoraria": "America/Bogota"
      }
    }
  }
]
```

**Respuesta exitosa:**
```json
{
  "success": true,
  "message": "GHL booking registered as PDTE",
  "data": {
    "id_registro_agenda": 19381,
    "categoria": "PDTE",
    "action": "created",
    "tagged": true
  }
}
```

> `action` es `"created"` si se insertó o `"updated"` si se encontró y actualizó un registro existente.

#### Mapeo de campos payload → BD (`resumenes_diarios_agendas`)

| Campo en BD | Fuente en el payload |
|---|---|
| `id_cuenta` | `body.customData.idcuenta` |
| `idcliente` | `body.customData.idcliente` |
| `ghl_contact_id` | `body.contact_id` |
| `nombre_de_lead` | `body.customData.nombre` → `body.first_name` → `body.full_name` |
| `email_lead` | `body.email` → `body.customData.email` |
| `origen` | `body.customData.origen` (si vacío → `"sin especificar"`) |
| `closer` | `body.customData.closer` |
| `"fecha de la reunion"` | `body.customData.hora` + `body.customData.zonahoraria` → UTC |
| `fecha` | Timestamp actual UTC (momento de procesamiento) |
| `categoria` | Ver tabla de acciones arriba |

---

### `POST /webhooks/twilio` — Llamada pendiente

Recibe el evento inicial cuando GHL detecta que hay una llamada saliente por realizar. Registra el lead en BD con estado `pdte`.

**URL que configuras en n8n:** `https://tu-dominio.run.app/webhooks/twilio`

**Mismo formato de payload** que los demás webhooks de llamada (ver abajo). El `locationid` llega en `body.location.id`.

**Respuesta exitosa:**
```json
{
  "success": true,
  "message": "Call event registered",
  "data": { "id_registro": 3808 }
}
```

#### Mapeo de campos payload → BD (`registros_de_llamada`)

| Campo en BD | Fuente en el payload | Valor inicial |
|---|---|---|
| `nombre_lead` | `body.customData.nombre` → `body.full_name` → `body.first_name` | — |
| `mail_lead` | `body.customData.email` | — |
| `phone_raw_format` | `body.customData.numero` → `body.phone` | — |
| `creativo_origen` | `body.customData.utm` | — |
| `closer_mail` | `body.customData.closermail` | — |
| `nombre_closer` | `body.customData.nombrecloser` | — |
| `id_cuenta` | Lookup en `public.cuentas WHERE locationid = body.location.id` | — |
| `estado` | — | `"pdte"` |
| `fecha_evento` | — | Timestamp actual UTC |
| `intentos_contacto` | — | `0` |
| `fecha_y_hora_de_seguimiento`, `trancription`, `callsid`, `iadescripcion` | — | `null` (se llenan en eventos posteriores) |

**Ejemplo de payload:**
```json
[
  {
    "body": {
      "contact_id": "tQ7bsDUBqCTDBtrrXIKP",
      "full_name": "Sergio",
      "phone": "+529981456060",
      "location": { "id": "gpquUsStA2ZEri53oPgc", "name": "Shark Realtors" },
      "customData": {
        "nombre": "Sergio",
        "email": "tQ7bsDUBqCTDBtrrXIKP",
        "numero": "+529981456060",
        "utm": "",
        "closermail": "gianina@empresa.com",
        "nombrecloser": "Gianina Cantu"
      }
    }
  }
]
```

---

### `POST /webhooks/twilio/no-answer` — Llamada no contestada

GHL avisa que la llamada no fue contestada. El sistema busca un registro activo del lead y lo actualiza; si no existe, crea uno nuevo.

**URL que configuras en n8n:** `https://tu-dominio.run.app/webhooks/twilio/no-answer`

> En este endpoint, `locationid` llega dentro de `customData.locationid` (no en `body.location.id`). El servicio resuelve ambas ubicaciones automáticamente.

**Lógica interna:**

```
1. Busca registro activo:
   WHERE LOWER(mail_lead) = LOWER(email) AND id_cuenta = ?
   AND (estado IN ('pdte','seguimiento','no_contestada','no_contestado') OR estado IS NULL)
   ORDER BY fecha_evento DESC LIMIT 1

2a. Si EXISTE → UPDATE:
    estado = 'seguimiento', intentos_contacto = anterior + 1,
    fecha_y_hora_de_seguimiento = ahora UTC

2b. Si NO EXISTE → INSERT completo:
    estado = 'seguimiento', intentos_contacto = 1,
    fecha_primera_llamada = ahora UTC

3. Aplica tag 'no_contestallamadaautoia' en GHL
   (token obtenido de public.cuentas por locationid)
```

**Respuesta exitosa:**
```json
{
  "success": true,
  "message": "No-answer call event processed",
  "data": { "id_registro": 3808, "action": "updated" }
}
```

> `action` = `"updated"` si actualizó, `"created"` si insertó nuevo.

---

### `POST /webhooks/twilio/effective` — Llamada efectiva

El pipeline más complejo del sistema. GHL avisa que la llamada se realizó. El Cerebro:
1. Consulta Twilio para obtener la grabación
2. Transcribe el audio con **OpenAI Whisper**
3. Clasifica la llamada con **GPT-4o-mini**
4. Actualiza o crea registro en BD
5. Aplica tag dinámico + nota en GHL

**URL que configuras en n8n:** `https://tu-dominio.run.app/webhooks/twilio/effective`

**Respuesta (siempre `200 OK` inmediato):**

> El endpoint responde de inmediato para evitar timeouts. Todo el pipeline se ejecuta en **segundo plano**.

```json
{
  "success": true,
  "message": "Effective call event received and processing"
}
```

#### Flujo completo paso a paso

```
Llega payload
     │
     ▼
[1] Resolve Account
    Busca en public.cuentas por locationid
    → Obtiene: token_ghl, twilio_sid, auth_twilio
     │
     ▼ (si falta twilio_sid/auth_twilio o teléfono → saltar a CAMINO A)
     │
[2] Pipeline Twilio (3 llamadas con Basic Auth)
    GET /Accounts/{sid}/Calls.json?To={phone}&Status=completed&PageSize=1 → callSid
    GET /Accounts/{sid}/Calls/{callSid}/Recordings.json → recordingSid
    GET /Accounts/{sid}/Recordings/{recordingSid}.mp3 → buffer de audio
     │
     ▼ (si falla cualquier paso, audio vacío o < 5KB → CAMINO A)
     │
[3] Whisper (OpenAI)
    Transcribe el audio a texto
     │
     ▼ (si falla o transcripción vacía → CAMINO A)
     │
[4] GPT-4o-mini
    Clasifica: buzon (bool|null), estado, iadesc
     │
     ├── buzon = true o null ──────────────────── CAMINO A
     │
     └── buzon = false ─────────────────────────── CAMINO B
```

#### Camino A — followUpPath (sin contestar / buzón / error)

Aplica la misma lógica que `/no-answer`:
- Busca registro activo → UPDATE `estado=seguimiento`, `intentos+1`
- Si no existe → INSERT con `estado=seguimiento`, `intentos=1`
- Tag GHL: `no_contestallamadaautoia`
- Nota GHL: `"Llamada no contestada"`

#### Camino B — effectivePath (persona contestó)

- Busca el registro **más reciente** por `mail_lead + id_cuenta` (sin filtro de estado)
- Si existe Y estado es activo (`pdte` / `seguimiento` / `no_*` / NULL) → **UPDATE**:
  - `estado` = el que devolvió la IA
  - `trancription` = texto de Whisper
  - `iadescripcion` = descripción de la IA
  - `callsid` = SID de la llamada
  - `intentos_contacto` = anterior + 1
- Si no existe O estado inactivo → **INSERT** completo
- Tag dinámico según el estado IA:

| Estado IA devuelto | Tag GHL aplicado |
|---|---|
| `interesado` | `interesadollamadaautoia` |
| `programado` | `programadollamadaautoia` |
| `no_interesado` | `no_interesadollamadaautoia` |
| `seguimiento` / `no_contestada` / `null` | `no_contestallamadaautoia` |

#### Clasificación IA — output de GPT-4o-mini

```json
{
  "buzon": false,
  "estado": "interesado",
  "iadesc": "Prospecto interesado en lotes. Preguntó costos y financiamiento. Cita agendada martes 10am."
}
```

| Campo | Tipo | Significado |
|---|---|---|
| `buzon` | `boolean \| null` | `true` = buzón de voz real, `false` = persona contestó, `null` = indeterminado |
| `estado` | `string \| null` | `seguimiento`, `programado`, `interesado`, `no_interesado` |
| `iadesc` | `string \| null` | Resumen breve útil para el asesor (2-3 oraciones) |

#### ¿Dónde se configuran las credenciales de Twilio?

En la tabla `public.cuentas`, en los campos `twilio_sid` y `auth_twilio` para cada cliente. Ver sección [Configuración de Cuentas](#configuración-de-cuentas-en-la-bd).

---

### `POST /webhooks/fathom/:id_cuenta` — Videollamada

Recibe la grabación y transcripción de una videollamada de Fathom (vía n8n). El `:id_cuenta` en la URL identifica el tenant.

**URL que configuras en n8n:** `https://tu-dominio.run.app/webhooks/fathom/3`  
(sustituye `3` por el `id_cuenta` real de ese cliente)

**Límite de payload:** 10 MB (las transcripciones pueden ser largas).

**Respuesta (siempre `200 OK` inmediato):**

> Responde de inmediato para no bloquear reintentos de Fathom/n8n. El procesamiento ocurre en **segundo plano**.

```json
{ "success": true, "message": "Fathom event received" }
```

#### Flujo de procesamiento (5 fases)

```
[Fase 1] Data Prep
  Extrae: closerEmail, closerName, shareUrl, transcript formateado
  Identifica email_lead desde calendar_invitees:
    → Filtra is_external=true y email ≠ recorded_by.email
    → Si hay varios externos, itera hasta encontrar uno con match en GHL
    → Si ninguno tiene match, usa el primero como fallback

[Fase 2] DB Fetch
  SELECT token_ghl, locationid, prompt_ventas
  FROM public.cuentas WHERE id_cuenta = :id_cuenta

[Fase 3] GHL Fetch
  GET /contacts/?locationId={locationid}&query={email_lead}
    → Obtiene: contactId, contactName, utmContent, assignedUserId
  Si assignedUserId existe:
    GET /users/{assignedUserId}
    → Obtiene email real del closer asignado en GHL

[Fase 4] Motor IA — 4 llamadas GPT-4o-mini en PARALELO (Promise.allSettled)
  ┌─ 1. Clasificador comercial → categoria + cash_collected + facturacion
  ├─ 2. Análisis forense → resumen_ia  (usa prompt_ventas del cliente, o genérico)
  ├─ 3. Lead Report 6 puntos → reportmarketing
  └─ 4. Extractor de objeciones → objeciones_ia (array JSON)
  Si una falla, las otras 3 continúan. Campos sin resultado quedan null.

[Fase 5] Sync Final
  5a. Aplica tag en GHL según categoría IA (cerradaautoia / ofertadaautoia / noofertadaautoia)
  5b. UPSERT en resumenes_diarios_agendas:
      → Busca registro más reciente por email_lead + id_cuenta
      → Si EXISTE: UPDATE con datos de IA
      → Si NO EXISTE: INSERT completo (fecha y fecha_reunion = ahora UTC)
```

#### Tags GHL aplicados por la IA

| Categoría IA | Tag GHL |
|---|---|
| `Cerrada` | `cerradaautoia` |
| `Ofertada` | `ofertadaautoia` |
| `No_Ofertada` | `noofertadaautoia` |

#### Campos que se escriben en `resumenes_diarios_agendas`

| Campo en BD | Fuente |
|---|---|
| `categoria` | Clasificador IA |
| `cash_collected` | Clasificador IA (ej: `"1500"`) |
| `facturacion` | Clasificador IA |
| `resumen_ia` | Análisis forense (Markdown) |
| `reportmarketing` | Lead Report 6 puntos |
| `objeciones_ia` | Array JSON `[{objecion, categoria}]` |
| `link_llamada` | `share_url` del payload Fathom |
| `origen` | `utmContent` del contacto en GHL |
| `ghl_contact_id` | ID del contacto en GHL |
| `nombre_de_lead` | `firstName + lastName` del contacto en GHL |
| `closer` | Email del closer asignado en GHL (o nombre del grabador como fallback) |

#### ¿Cómo se personaliza el análisis por cliente?

Cada cliente puede tener un `prompt_ventas` propio en `public.cuentas`. Ese prompt se inyecta en el análisis forense (Fase 4, análisis #2). Si el campo es `NULL`, se usa un prompt genérico de calificación de ventas.

**Ejemplo de payload de Fathom (formato directo):**
```json
{
  "recording_id": 123827160,
  "share_url": "https://fathom.video/share/abc123",
  "recorded_by": {
    "email": "asesor@empresa.com",
    "name": "Asesor Felipe"
  },
  "calendar_invitees": [
    { "email": "lead@gmail.com", "is_external": true, "name": "Cristian" },
    { "email": "asesor@empresa.com", "is_external": false, "name": "Asesor Felipe" }
  ],
  "transcript": [
    {
      "speaker": { "display_name": "Asesor Felipe" },
      "text": "Buenos días, ¿cómo estás?",
      "timestamp": "00:00:05"
    }
  ]
}
```

> También acepta el formato n8n envuelto: `[{ "body": { ...datos... } }]`

---

### `POST /cron/update-no-shows` — Cron No-Shows

Endpoint interno llamado por tu scheduler externo (cron). Marca masivamente como `no_show` todas las citas `PDTE` de cuentas específicas cuya fecha de reunión coincida con la fecha indicada, y aplica el tag `noshowautoia` en GHL.

**URL que configuras en tu cron:** `https://tu-dominio.run.app/cron/update-no-shows`

#### Headers requeridos

| Header | Valor |
|---|---|
| `x-cron-secret` | Debe coincidir con la variable `CRON_SECRET` de tu `.env`. Si no coincide → `401 Unauthorized`. |
| `Content-Type` | `application/json` |

#### Body

```json
{
  "event": "daily-no-show-check",
  "target_date": "2026-02-23",
  "account_ids": [1, 2, 5]
}
```

| Campo | Tipo | Reglas |
|---|---|---|
| `event` | string | Obligatorio (mínimo 1 carácter) |
| `target_date` | string | Obligatorio, formato `YYYY-MM-DD` |
| `account_ids` | number[] | Obligatorio, mínimo 1 elemento |

#### ¿Qué hace internamente?

```
1. UPDATE resumenes_diarios_agendas
   SET categoria = 'no_show', tags = CONCAT(tags, ',noshowautoia')
   WHERE id_cuenta IN (account_ids)
     AND CAST("fecha de la reunion" AS date) = target_date
     AND categoria = 'PDTE'

2. RETURNING id_registro_agenda, id_cuenta, ghl_contact_id

3. SELECT token_ghl FROM public.cuentas
   WHERE id_cuenta IN (id_cuentas únicos del resultado)

4. Aplica tag 'noshowautoia' en GHL a cada ghl_contact_id
   usando su respectivo token_ghl.
   Rate limiting: lotes de 10 requests con 500ms de pausa
   (evita errores 429 de la API de GHL)
```

#### Respuestas

**Exitosa con registros:**
```json
{
  "success": true,
  "target_date": "2026-02-23",
  "processed_count": 5,
  "updated_ids": [19381, 19382, 19383, 19384, 19385],
  "tagged_count": 5
}
```

**Sin registros que actualizar:**
```json
{
  "success": true,
  "target_date": "2026-02-23",
  "processed_count": 0,
  "updated_ids": [],
  "tagged_count": 0
}
```

**Secret inválido:**
```json
{ "success": false, "error": "Unauthorized" }
```

---

## Esquema de Base de Datos

### `resumenes_diarios_agendas` — Tabla maestra de citas y videollamadas

> Es la tabla principal del sistema. Aquí convergen los eventos de GHL (citas) y Fathom (videollamadas).

| Columna | Tipo | Descripción |
|---|---|---|
| `id_registro_agenda` | serial PK | Autoincremental |
| `id_cuenta` | integer NOT NULL | Tenant ID (FK a `public.cuentas`) |
| `idcliente` | text | Identificador único del lead en el sistema del cliente |
| `ghl_contact_id` | text | Contact ID en GoHighLevel (usado para tags/notas) |
| `fecha` | timestamptz | Momento en que se procesó el webhook (UTC) |
| `nombre_de_lead` | text | Nombre del prospecto |
| `origen` | text | Campaña/fuente / `utmContent` de GHL |
| `email_lead` | text | Email del lead (llave para buscar registros) |
| `categoria` | text | `PDTE`, `CANCELADA`, `no_show`, `Cerrada`, `Ofertada`, `No_Ofertada` |
| `closer` | text | Asesor asignado (email o nombre) |
| `tags` | text | Tags separados por coma (ej: `pdteautoia,noshowautoia`) |
| `"fecha de la reunion"` | timestamptz | Fecha/hora de la cita en UTC |
| `cash_collected` | text | Monto cobrado en videollamada (string numérico, ej: `"1500"`) |
| `facturacion` | text | Valor total del acuerdo (string numérico) |
| `resumen_ia` | text | Análisis forense en Markdown (generado por IA según `prompt_ventas`) |
| `link_llamada` | text | URL de la grabación en Fathom |
| `objeciones_ia` | jsonb | Array de `{objecion: string, categoria: string}` |
| `reportmarketing` | text | Lead Report de 6 puntos generado por IA |

---

### `registros_de_llamada` — Historial de llamadas telefónicas

> Tabla exclusiva para el ciclo de vida de las llamadas telefónicas (Twilio + GHL).

| Columna | Tipo | Descripción |
|---|---|---|
| `id_registro` | serial PK | Autoincremental |
| `fecha_evento` | timestamptz | Momento de recepción del webhook (UTC) |
| `id_cuenta` | integer | FK a `public.cuentas`, resuelto desde `locationid` |
| `nombre_lead` | text | Nombre del prospecto |
| `estado` | text | `pdte` → `seguimiento` → `interesado` / `programado` / `no_interesado` |
| `mail_lead` | text | Email o contact_id del lead (según el CRM del cliente) |
| `phone_raw_format` | text | Teléfono sin normalizar |
| `creativo_origen` | text | UTM/creativo de origen |
| `closer_mail` | text | Email del asesor asignado |
| `nombre_closer` | text | Nombre del asesor asignado |
| `fecha_y_hora_de_seguimiento` | timestamptz | Próximo seguimiento programado (UTC) |
| `speed_to_lead` | text | Minutos desde que la llamada fue "pdte" hasta que cambió de estado (se calcula automáticamente) |
| `intentos_contacto` | integer | Número de intentos de contacto acumulados |
| `fecha_primera_llamada` | timestamptz | Momento de la primera llamada registrada (UTC) |
| `trancription` | text | Transcripción del audio (Whisper) — *typo del esquema original de BD preservado* |
| `callsid` | text | SID de la llamada en Twilio |
| `iadescripcion` | text | Análisis IA de la llamada (GPT-4o-mini) |
| `id_user_ghl` | text | ID del contacto en GHL (alternativa al email, llega como `customData.id_customer_ghl`) |

---

### `public.cuentas` — Tabla de tenants/clientes

> Ver sección [Configuración de Cuentas](#configuración-de-cuentas-en-la-bd) para saber cómo llenarla.

| Columna | Tipo | Descripción |
|---|---|---|
| `id_cuenta` | serial PK | Autoincremental |
| `nombre_cuenta` | text | Nombre descriptivo del cliente |
| `locationid` | text | Location ID de GHL. Match exacto (`WHERE locationid = ?`) |
| `token_ghl` | text | `Bearer pit-...` — **incluye el prefijo `Bearer `** |
| `prompt_ventas` | text | Prompt personalizado para análisis Fathom. `NULL` → usa prompt genérico |
| `twilio_sid` | text | Account SID de Twilio (`AC...`) |
| `auth_twilio` | text | Auth Token de Twilio |

---

## Tags GHL Implementados

Todos los tags se aplican vía `POST https://services.leadconnectorhq.com/contacts/{contactId}/tags` usando el `token_ghl` de la cuenta correspondiente.

| Evento | Tag aplicado |
|---|---|
| Cita agendada (pendiente) | `pdteautoia` |
| Cita cancelada | `canceladaautoia` |
| Cita reagendada | `reagendadoautoia` |
| No-show (cron diario) | `noshowautoia` |
| Videollamada cerrada (Fathom IA) | `cerradaautoia` |
| Videollamada ofertada (Fathom IA) | `ofertadaautoia` |
| Videollamada no ofertada (Fathom IA) | `noofertadaautoia` |
| Llamada no contestada / buzón / error | `no_contestallamadaautoia` |
| Llamada efectiva — lead interesado | `interesadollamadaautoia` |
| Llamada efectiva — cita para hablar después | `programadollamadaautoia` |
| Llamada efectiva — no interesado | `no_interesadollamadaautoia` |

**Notas GHL** (vía `POST /contacts/{contactId}/notes`):

| Evento | Contenido de la nota |
|---|---|
| Llamada no contestada / buzón / cualquier error en pipeline Twilio | `"Llamada no contestada"` |

---

## Despliegue en Google Cloud Run

El proyecto incluye un `Dockerfile` multi-stage optimizado con imagen distroless. Para deployar:

```bash
# 1. Build de la imagen
docker build -t cerebro-tracker .

# 2. Tag y push a Google Container Registry (o Artifact Registry)
docker tag cerebro-tracker gcr.io/TU_PROYECTO/cerebro-tracker
docker push gcr.io/TU_PROYECTO/cerebro-tracker

# 3. Deploy en Cloud Run
gcloud run deploy cerebro-tracker \
  --image gcr.io/TU_PROYECTO/cerebro-tracker \
  --platform managed \
  --region us-central1 \
  --port 8080 \
  --set-env-vars DATABASE_URL=...,OPENAI_API_KEY=...,CRON_SECRET=...
```

> Cloud Run asigna automáticamente una URL del tipo `https://cerebro-tracker-xxxx-uc.a.run.app`.  
> Esa URL es la que configuras en n8n para todos los webhooks.

### Variables de entorno en Cloud Run

En la consola de Google Cloud → Cloud Run → tu servicio → Edit & Deploy → Variables & Secrets, agrega:

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `CRON_SECRET`
- `NODE_ENV=production`

---

## Estructura del Proyecto

```
src/
├── server.ts                          # Entry point — levanta Fastify en 0.0.0.0:8080
├── app.ts                             # buildApp() — instancia Fastify + registra rutas
│
├── config/
│   ├── env.ts                         # Valida variables de entorno al arrancar (fail-fast)
│   ├── database.ts                    # Pool de conexión PostgreSQL (pg)
│   └── drizzle.ts                     # Instancia Drizzle ORM sobre el pool
│
├── db/
│   └── schema.ts                      # Definición de tablas: agendas, llamadas, cuentas
│
├── plugins/
│   └── error-handler.ts               # Error handler global + 404 para Fastify
│
├── routes/                            # Solo define endpoints — cero lógica aquí
│   ├── health.route.ts                # GET /health
│   ├── webhooks/
│   │   ├── ghl.route.ts               # POST /webhooks/ghl
│   │   ├── fathom.route.ts            # POST /webhooks/fathom/:id_cuenta (10MB)
│   │   └── twilio.route.ts            # POST /webhooks/twilio + /no-answer + /effective
│   └── cron/
│       └── daily-tasks.route.ts       # POST /cron/update-no-shows
│
├── controllers/                       # Recibe la request, normaliza payload y llama al servicio
│   ├── webhooks/
│   │   ├── ghl.controller.ts          # Usa extractWebhookBody → llama ghl.service
│   │   ├── fathom.controller.ts       # Usa extractWebhookBody → responde 200 inmediato
│   │   └── twilio.controller.ts       # 3 handlers: pdte / no-answer / effective
│   └── cron/
│       └── daily-tasks.controller.ts  # Verifica x-cron-secret → 401 si falla
│
├── services/                          # Toda la lógica de negocio vive aquí
│   ├── ghl-api.service.ts             # GHL HTTP API: tags, notas, búsqueda de contactos
│   ├── twilio-api.service.ts          # Twilio REST API: calls, recordings, download audio
│   ├── webhooks/
│   │   ├── ghl.service.ts             # Dispatcher: pendiente / cancelada / reagenda
│   │   ├── fathom.service.ts          # Orquestador 5 fases + upsert en BD
│   │   └── twilio.service.ts          # 3 flujos: pdte, no-answer, effective (Whisper+IA)
│   ├── ai/
│   │   ├── call-analysis.service.ts   # 4 IAs en paralelo para videollamadas Fathom
│   │   └── call-classification.service.ts  # Whisper + GPT-4o-mini para llamadas Twilio
│   └── cron/
│       └── daily-tasks.service.ts     # Batch no-show (Drizzle) + GHL tagging con rate limit
│
├── schemas/                           # Validación TypeBox de payloads entrantes
│   ├── webhooks/
│   │   ├── ghl.schema.ts
│   │   ├── fathom.schema.ts
│   │   └── twilio.schema.ts
│   └── cron/
│       └── daily-tasks.schema.ts
│
└── utils/
    ├── payload.utils.ts               # extractWebhookBody — detecta formato directo vs n8n
    ├── date.utils.ts                  # Parsea fechas en español + IANA timezone → UTC
    ├── batch.utils.ts                 # processInChunks — rate limiting para APIs externas
    └── fetch.utils.ts                 # fetchWithTimeout — fetch con AbortController
```

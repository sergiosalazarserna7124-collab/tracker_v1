# Harness E2E — Eventos reales al tenant demo (52)

Envía webhooks reales al Cerebro en producción usando la cuenta **demo** (id 52, locationId `QfAM4c37M8mR2xBxqJaJ`).
Cada script dispara el flujo completo: recepción → clasificación IA → escritura en BD.

## Requisitos

- `curl`, `jq`, `psql` instalados
- Acceso a internet (los scripts apuntan al Cerebro en Cloud Run)

## Uso

### Llamada (CallAI / voz)

> **Requiere** exportar `VOZ_SECRET` (el secret de escritura `x-voz-secret`). No viene por defecto.

```bash
export VOZ_SECRET=voz_xxxxx   # secret de escritura del endpoint de voz

# Con valores por defecto
./scripts/e2e/send-call.sh

# Con transcripción y estado custom
./scripts/e2e/send-call.sh "Cliente: Quiero cancelar" "no_interesado"
```

Estados válidos: `interesado`, `no_interesado`, `no_elegible`, `reagendado`, `no_contesto`, `buzon_voz`, `colgo_temprano`, `agendado`, `confirmado`.

Escribe en: `registros_de_llamada`

### Chat (GHL)

```bash
# Con valores por defecto
./scripts/e2e/send-chat.sh

# Con mensaje y dirección custom
./scripts/e2e/send-chat.sh "Quiero agendar una cita" "inbound"
```

Escribe en: `chats_logs`

### Videollamada (Fathom)

```bash
# Con valores por defecto
./scripts/e2e/send-videocall.sh

# Con título custom
./scripts/e2e/send-videocall.sh "Reunión de cierre — Cliente VIP"
```

Escribe en: `resumenes_diarios_agendas`

## Variables de entorno opcionales

| Variable | Default | Descripción |
|---|---|---|
| `CEREBRO_URL` | URL de producción Cloud Run | Override para apuntar a otro entorno |
| `VOZ_SECRET` | **(requerido, sin default)** | Header `x-voz-secret` para el endpoint de voz. El script aborta si no está seteado — no se hardcodea el secret en el repo. |

## Verificación

Cada script:
1. Envía el webhook al Cerebro
2. Espera el procesamiento async (8-15s)
3. Consulta la BD en readonly y muestra los últimos registros
4. Imprime el link al dashboard de demo para verificación visual

## Caveat: Fathom (videollamada)

El flujo Fathom depende de que el email del lead exista como **contacto en GHL**
para la cuenta demo. Si el contacto no existe, `nombre_de_lead` queda NULL y
el INSERT falla por constraint NOT NULL en `resumenes_diarios_agendas`.

Esto es una limitación conocida del servicio Cerebro (debería usar el `name`
del `calendar_invitee` como fallback). El webhook sí se procesa completo
(clasificación IA incluida) — solo falla la escritura final en BD.

## Limpieza

Los registros de prueba quedan en la cuenta demo (52). No afectan a clientes reales.

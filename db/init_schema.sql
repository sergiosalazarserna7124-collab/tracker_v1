-- ============================================================================
-- init_schema.sql — Esquema base completo para Cerebro Tracker V6 SaaS
-- ============================================================================
--
-- PROPÓSITO
--   El repositorio NO incluye el DDL inicial: las 56 migraciones en /migrations
--   solo *modifican* tablas que se asumen ya creadas. Este archivo reconstruye
--   el esquema base completo (todas las tablas + columnas + constraints + índices)
--   a partir de src/db/schema.ts y de las sentencias SQL del código.
--
-- CÓMO USARLO (Supabase)
--   1. Crea el proyecto en Supabase (PostgreSQL 15).
--   2. Abre el "SQL Editor" y pega TODO este archivo. Ejecuta (Run).
--   3. Al arrancar la app, src/db/migrate.ts detecta que la tabla `cuentas`
--      ya existe y marca las 56 migraciones como aplicadas (baseline seed),
--      por lo que no vuelve a ejecutarlas. Esquema listo.
--
-- Idempotente: usa IF NOT EXISTS en todo. Se puede re-ejecutar sin romper nada.
-- ============================================================================

-- gen_random_uuid() es nativo en PostgreSQL 13+ (Supabase = PG15). Por si acaso:
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. cuentas — tabla maestra de tenants/clientes
-- ============================================================================
CREATE TABLE IF NOT EXISTS cuentas (
  id_cuenta                      SERIAL PRIMARY KEY,
  nombre_cuenta                  TEXT,
  id_cuenta_padre                INTEGER,
  identificador_url              TEXT,
  locationid                     TEXT,
  token_ghl                      TEXT,
  token_ghl_status               TEXT DEFAULT 'unknown',
  ghl_app_uninstalled_at         TIMESTAMPTZ,
  prompt_ventas                  TEXT,
  twilio_sid                     TEXT,
  auth_twilio                    TEXT,
  openai_api_key                 TEXT,
  embudo_personalizado           JSONB,
  tipos_eventos_config           JSONB,
  roles_config                   JSONB,
  prompt_videollamadas           TEXT,
  prompt_llamadas                TEXT,
  reglas_etiquetas               JSONB,
  categorias_llamadas            JSONB,
  configuracion_ads              JSONB,
  metricas_config                JSONB,
  metricas_manual_data           JSONB,
  razones_perdida_config         JSONB,
  razones_perdida_data           JSONB,
  estado_cuenta                  TEXT,
  chatbot_transfer_marker        TEXT,
  closer_merge_rules             JSONB,
  criterios_calificacion         JSONB,
  config_llamadas                JSONB,
  ghl_opportunity_fields_config  JSONB,
  canales_activos                JSONB,
  ghl_native_task_workflow       BOOLEAN NOT NULL DEFAULT false,
  zona_horaria_iana              TEXT,
  coach_habilitado               BOOLEAN NOT NULL DEFAULT false,
  etiquetas_descarte             JSONB,
  exclusiones_coach              JSONB,
  gemini_api_key                 TEXT,
  gemini_premium_status          TEXT DEFAULT 'off',
  gemini_backfill_status         TEXT,
  gemini_backfill_cap            INTEGER DEFAULT 200
);

-- ============================================================================
-- 2. resumenes_diarios_agendas — Citas y videollamadas (Fathom)
-- ============================================================================
CREATE TABLE IF NOT EXISTS resumenes_diarios_agendas (
  id_registro_agenda        SERIAL PRIMARY KEY,
  id_cuenta                 INTEGER NOT NULL,
  idcliente                 TEXT,
  ghl_contact_id            TEXT,
  ghl_appointment_id        TEXT,
  fecha                     TIMESTAMPTZ,
  nombre_de_lead            TEXT,
  origen                    TEXT,
  email_lead                TEXT,
  categoria                 TEXT,
  estado_cita               TEXT,
  closer                    TEXT,
  tags                      TEXT,
  fecha_reunion             TIMESTAMPTZ,
  cash_collected            TEXT,
  facturacion               TEXT,
  resumen_ia                TEXT,
  link_llamada              TEXT,
  objeciones_ia             JSONB,
  reportmarketing           TEXT,
  tags_internos             JSONB,
  fathom_recording_id       TEXT,
  fathom_share_url          TEXT,
  fathom_processed_at       TIMESTAMPTZ,
  fathom_ingestion_source   TEXT,
  transcripcion_fathom      TEXT,
  fathom_reingest_at        TIMESTAMPTZ,
  categoria_previa          TEXT,
  gemini_enriquecimiento    JSONB,
  duracion_segundos         INTEGER,
  ubicacion_aprox           TEXT,
  gemini_intentos           SMALLINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agendas_cuenta_contact_pdte
  ON resumenes_diarios_agendas (id_cuenta, ghl_contact_id) WHERE categoria = 'PDTE';
CREATE INDEX IF NOT EXISTS idx_agendas_cuenta_email_pdte
  ON resumenes_diarios_agendas (id_cuenta, LOWER(email_lead)) WHERE categoria = 'PDTE';

-- ============================================================================
-- 3. registros_de_llamada — Estado actual de llamadas telefónicas (Twilio)
-- ============================================================================
CREATE TABLE IF NOT EXISTS registros_de_llamada (
  id_registro                    SERIAL PRIMARY KEY,
  fecha_evento                   TIMESTAMPTZ,
  id_cuenta                      INTEGER,
  nombre_lead                    TEXT,
  estado                         TEXT,
  mail_lead                      TEXT,
  phone_raw_format               TEXT,
  creativo_origen                TEXT,
  closer_mail                    TEXT,
  nombre_closer                  TEXT,
  fecha_y_hora_de_seguimiento    TIMESTAMPTZ,
  speed_to_lead                  TEXT,
  intentos_contacto              INTEGER DEFAULT 0,
  fecha_primera_llamada          TIMESTAMPTZ,
  trancription                   TEXT,
  callsid                        TEXT,
  iadescripcion                  TEXT,
  id_user_ghl                    TEXT,
  ghl_contact_id                 TEXT,
  tags_internos                  JSONB,
  lead_embudo_personalizado      JSONB,
  speed_to_lead_alerted_at       TIMESTAMPTZ,
  speed_to_lead_4h_alerted_at    TIMESTAMPTZ,
  agentid                        TEXT,
  gemini_enriquecimiento         JSONB,
  duracion_segundos              INTEGER,
  ubicacion_aprox                TEXT,
  ia_objeciones                  JSONB,
  excluido_metricas              BOOLEAN NOT NULL DEFAULT false,
  calificacion_manual            TEXT,
  resumen_llamada                JSONB
);

-- ============================================================================
-- 4. log_llamadas — Historial inmutable de eventos de llamadas
-- ============================================================================
CREATE TABLE IF NOT EXISTS log_llamadas (
  id                          BIGSERIAL PRIMARY KEY,
  id_registro                 INTEGER,
  id_cuenta                   INTEGER NOT NULL,
  mail_lead                   TEXT,
  id_user_ghl                 TEXT,
  contact_id_ghl              TEXT,
  nombre_lead                 TEXT,
  phone                       TEXT,
  tipo_evento                 TEXT NOT NULL,
  estado_resultado            TEXT,
  call_sid                    TEXT,
  transcripcion               TEXT,
  ia_descripcion              TEXT,
  closer_mail                 TEXT,
  nombre_closer               TEXT,
  creativo_origen             TEXT,
  speed_to_lead               TEXT,
  ts                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  tags_internos               JSONB,
  lead_embudo_personalizado   JSONB,
  agentid                     TEXT,
  gemini_enriquecimiento      JSONB,
  duracion_segundos           INTEGER,
  ubicacion_aprox             TEXT,
  ia_objeciones               JSONB,
  calificacion_manual         TEXT,
  gemini_intentos             SMALLINT NOT NULL DEFAULT 0,
  resumen_llamada             JSONB
);

-- ============================================================================
-- 5. chats_logs — Conversaciones de chat (reconstruida desde el código)
-- ============================================================================
CREATE TABLE IF NOT EXISTS chats_logs (
  id_evento                       SERIAL PRIMARY KEY,
  id_cuenta                       INTEGER NOT NULL,
  nombre_lead                     TEXT,
  id_lead                         TEXT,
  chatid                          TEXT UNIQUE,
  fecha_y_hora_z                  TIMESTAMPTZ,
  estado                          TEXT,
  notas_extra                     TEXT,
  chat                            JSONB,
  asesor_asignado                 TEXT,
  origen                          TEXT,
  primer_msg_lead_at              TIMESTAMPTZ,
  primer_msg_at                   TIMESTAMPTZ,
  bot_delegacion_at               TIMESTAMPTZ,
  ia_categoria                    TEXT,
  ia_analizado_at                 TIMESTAMPTZ,
  ia_objeciones                   JSONB,
  tags_internos                   JSONB,
  excluida_dashboard              BOOLEAN DEFAULT false,
  excluido_metricas               BOOLEAN,
  calificacion_manual             TEXT,
  chat_stl_alerted_at             TIMESTAMPTZ,
  chat_stl_4h_alerted_at          TIMESTAMPTZ,
  chat_sin_responder_tagged_at    TIMESTAMPTZ,
  chat_sin_responder_removed_at   TIMESTAMPTZ,
  duracion_segundos               INTEGER,
  gemini_enriquecimiento          JSONB,
  ubicacion_aprox                 TEXT,
  gemini_intentos                 SMALLINT NOT NULL DEFAULT 0,
  outbound_enriched_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_chats_logs_primer_msg_lead_at
  ON chats_logs (primer_msg_lead_at);
CREATE INDEX IF NOT EXISTS idx_chats_logs_cuenta ON chats_logs (id_cuenta);

-- ============================================================================
-- 6. chat_webhook_raw — Payloads crudos de webhooks de chat (auditoría/backfill)
-- ============================================================================
CREATE TABLE IF NOT EXISTS chat_webhook_raw (
  id                     BIGSERIAL PRIMARY KEY,
  location_id            TEXT,
  event_type             TEXT,
  direction              TEXT,
  channel_type_number    INTEGER,
  channel_type_string    TEXT,
  content_type           TEXT,
  status                 TEXT,
  has_attachments        BOOLEAN,
  processed              BOOLEAN,
  skip_reason            TEXT,
  payload                JSONB,
  received_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cwr_location_received
  ON chat_webhook_raw (location_id, received_at);

-- ============================================================================
-- 7. webhook_events_log — Log de webhooks entrantes (todas las fuentes)
-- ============================================================================
CREATE TABLE IF NOT EXISTS webhook_events_log (
  id             BIGSERIAL PRIMARY KEY,
  fuente         TEXT NOT NULL,
  tipo_evento    TEXT,
  location_id    TEXT,
  id_cuenta      INTEGER,
  payload_raw    JSONB,
  procesado      BOOLEAN,
  resultado      JSONB,
  error          TEXT,
  processing_ms  INTEGER,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- 8. resumenes_diarios_ads — Métricas diarias de Ads (Meta/Facebook)
-- ============================================================================
CREATE TABLE IF NOT EXISTS resumenes_diarios_ads (
  id                     SERIAL PRIMARY KEY,
  id_cuenta              INTEGER NOT NULL,
  fecha                  DATE NOT NULL,
  plataforma             TEXT,
  campana                TEXT,
  conjunto_anuncios      TEXT,
  gasto_total_ad         NUMERIC,
  impresiones_totales    BIGINT,
  clicks_unicos          INTEGER,
  cpm                    NUMERIC,
  cpc                    NUMERIC,
  ctr                    NUMERIC,
  datos_extra            JSONB
);
-- ON CONFLICT (id_cuenta, fecha, COALESCE(campana,'')) usado por sincronizar-ads
CREATE UNIQUE INDEX IF NOT EXISTS uq_ads_cuenta_fecha_campana
  ON resumenes_diarios_ads (id_cuenta, fecha, COALESCE(campana, ''));

-- ============================================================================
-- 9. metas_cuenta — Metas/umbrales de speed-to-lead por cuenta
-- ============================================================================
CREATE TABLE IF NOT EXISTS metas_cuenta (
  id_cuenta                        INTEGER PRIMARY KEY,
  meta_speed_chat_min              INTEGER,
  meta_tag_sin_responder_wait_min  INTEGER
);

-- ============================================================================
-- 10. kpis_externos — Ingesta de KPIs desde API externa
-- ============================================================================
CREATE TABLE IF NOT EXISTS kpis_externos (
  id_registro   SERIAL PRIMARY KEY,
  id_cuenta     INTEGER NOT NULL,
  fecha         DATE NOT NULL,
  origen        TEXT DEFAULT 'api_externa',
  metricas      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- 11. api_keys_cuenta — API keys por cuenta
-- ============================================================================
CREATE TABLE IF NOT EXISTS api_keys_cuenta (
  id_key       SERIAL PRIMARY KEY,
  id_cuenta    INTEGER NOT NULL,
  nombre_key   TEXT NOT NULL,
  token        TEXT UNIQUE NOT NULL,
  activa       BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- 12. uso_api_mensual — Consumo mensual de API por cuenta
-- ============================================================================
CREATE TABLE IF NOT EXISTS uso_api_mensual (
  id_uso        SERIAL PRIMARY KEY,
  id_cuenta     INTEGER NOT NULL,
  mes_anio      TEXT NOT NULL,
  tipo_consumo  TEXT NOT NULL,
  cantidad      INTEGER DEFAULT 0,
  UNIQUE (id_cuenta, mes_anio, tipo_consumo)
);

-- ============================================================================
-- 13. eventos_huerfanos — Webhooks sin datos clave (para re-procesar)
-- ============================================================================
CREATE TABLE IF NOT EXISTS eventos_huerfanos (
  id_huerfano        SERIAL PRIMARY KEY,
  id_cuenta          INTEGER,
  origen             TEXT NOT NULL,
  motivo             TEXT NOT NULL,
  payload_original   JSONB NOT NULL,
  estado             TEXT DEFAULT 'pendiente',
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- 14. usuarios_dashboard — Usuarios del dashboard (selección de key Fathom)
-- ============================================================================
CREATE TABLE IF NOT EXISTS usuarios_dashboard (
  id_evento   TEXT PRIMARY KEY,
  id_cuenta   INTEGER NOT NULL,
  fathom      TEXT
);

-- ============================================================================
-- 15. ghl_oauth_tokens — Tokens OAuth de GoHighLevel Marketplace
-- ============================================================================
CREATE TABLE IF NOT EXISTS ghl_oauth_tokens (
  id                  SERIAL PRIMARY KEY,
  location_id         TEXT NOT NULL UNIQUE,
  id_cuenta           INTEGER REFERENCES cuentas(id_cuenta) ON DELETE SET NULL,
  access_token        TEXT NOT NULL,
  refresh_token       TEXT NOT NULL,
  token_type          TEXT DEFAULT 'Bearer',
  expires_in          INTEGER,
  scope               TEXT,
  installed_at        TIMESTAMPTZ DEFAULT now(),
  last_refreshed_at   TIMESTAMPTZ DEFAULT now(),
  expires_at          TIMESTAMPTZ,
  user_type           TEXT,
  company_id          TEXT
);

-- ============================================================================
-- 16. ghl_pending_actions — Acciones GHL pendientes por token inválido
-- ============================================================================
CREATE TABLE IF NOT EXISTS ghl_pending_actions (
  id            SERIAL PRIMARY KEY,
  id_cuenta     INTEGER NOT NULL REFERENCES cuentas(id_cuenta) ON DELETE CASCADE,
  contact_id    TEXT NOT NULL,
  action_type   TEXT NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  retry_count   INTEGER DEFAULT 0,
  last_error    TEXT,
  resolved_at   TIMESTAMPTZ
);

-- ============================================================================
-- 17. closer_merge_suggestions — Sugerencias de dedup de closers
-- ============================================================================
CREATE TABLE IF NOT EXISTS closer_merge_suggestions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cuenta          INTEGER NOT NULL REFERENCES cuentas(id_cuenta) ON DELETE CASCADE,
  candidatos         JSONB NOT NULL,
  canonical_email    TEXT,
  canonical_nombre   TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  resuelto_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cms_cuenta_status
  ON closer_merge_suggestions (id_cuenta, status);

-- ============================================================================
-- 18. metrics + metric_data_points — Métricas personalizadas por cuenta
-- ============================================================================
CREATE TABLE IF NOT EXISTS metrics (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cuenta    INTEGER NOT NULL REFERENCES cuentas(id_cuenta) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_metrics_cuenta ON metrics (id_cuenta);

CREATE TABLE IF NOT EXISTS metric_data_points (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_id    UUID NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
  id_cuenta    INTEGER NOT NULL REFERENCES cuentas(id_cuenta) ON DELETE CASCADE,
  value        TEXT NOT NULL,
  ts           TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mdp_metric_cuenta_ts
  ON metric_data_points (metric_id, id_cuenta, ts);

-- ============================================================================
-- 19. mapeo_id_externo — Mapeo ID cliente externo → contacto GHL
-- ============================================================================
CREATE TABLE IF NOT EXISTS mapeo_id_externo (
  id                    SERIAL PRIMARY KEY,
  id_cuenta             INTEGER NOT NULL REFERENCES cuentas(id_cuenta) ON DELETE CASCADE,
  id_cliente_interno    TEXT NOT NULL,
  ghl_contact_id        TEXT NOT NULL,
  telefono              TEXT,
  email                 TEXT,
  nombre                TEXT,
  created_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mapeo_cuenta_cliente
  ON mapeo_id_externo (id_cuenta, id_cliente_interno);
CREATE INDEX IF NOT EXISTS idx_mapeo_cuenta_ghl
  ON mapeo_id_externo (id_cuenta, ghl_contact_id);

-- ============================================================================
-- 20. ghl_marketplace_shadow — Shadow log de eventos GHL Marketplace
-- ============================================================================
CREATE TABLE IF NOT EXISTS ghl_marketplace_shadow (
  id            BIGSERIAL PRIMARY KEY,
  event_type    TEXT,
  location_id   TEXT,
  headers       JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  signature_ok  BOOLEAN
);
CREATE INDEX IF NOT EXISTS idx_ghl_shadow_location ON ghl_marketplace_shadow (location_id);
CREATE INDEX IF NOT EXISTS idx_ghl_shadow_received ON ghl_marketplace_shadow (received_at);

-- ============================================================================
-- 21. guiones_coach + evaluaciones_coach — Coach de ventas
-- ============================================================================
CREATE TABLE IF NOT EXISTS guiones_coach (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cuenta              INTEGER NOT NULL REFERENCES cuentas(id_cuenta) ON DELETE CASCADE,
  categoria_llamada_id   TEXT NOT NULL,
  canal                  TEXT NOT NULL DEFAULT 'llamada',
  version                INTEGER NOT NULL DEFAULT 1,
  secciones              JSONB NOT NULL,
  umbral                 INTEGER NOT NULL DEFAULT 70,
  activo                 BOOLEAN NOT NULL DEFAULT true,
  nota_cumplido          TEXT,
  nota_no_cumplido       TEXT,
  tags_cumplido          JSONB,
  tags_no_cumplido       JSONB,
  created_at             TIMESTAMPTZ DEFAULT now(),
  updated_at             TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_guiones_cuenta_cat
  ON guiones_coach (id_cuenta, categoria_llamada_id);
CREATE INDEX IF NOT EXISTS idx_guiones_cuenta_canal_cat
  ON guiones_coach (id_cuenta, canal, categoria_llamada_id);

CREATE TABLE IF NOT EXISTS evaluaciones_coach (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cuenta                         INTEGER NOT NULL REFERENCES cuentas(id_cuenta) ON DELETE CASCADE,
  log_llamada_id                    INTEGER NOT NULL,
  canal                             TEXT NOT NULL DEFAULT 'llamada',
  guion_id                          UUID NOT NULL REFERENCES guiones_coach(id) ON DELETE CASCADE,
  guion_version                     INTEGER NOT NULL,
  scores_secciones                  JSONB NOT NULL,
  score_total                       INTEGER NOT NULL,
  cumple_umbral                     BOOLEAN NOT NULL,
  secciones_faltantes_must_have     JSONB,
  nota_accionable                   TEXT,
  ghl_tag_applied                   TEXT,
  evaluated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_eval_cuenta_canal_origen
  ON evaluaciones_coach (id_cuenta, canal, log_llamada_id);
CREATE INDEX IF NOT EXISTS idx_eval_guion ON evaluaciones_coach (guion_id);

-- ============================================================================
-- 22. metricas_webhook — Métricas recibidas por webhook
-- ============================================================================
CREATE TABLE IF NOT EXISTS metricas_webhook (
  id                SERIAL PRIMARY KEY,
  id_cuenta         INTEGER NOT NULL REFERENCES cuentas(id_cuenta) ON DELETE CASCADE,
  fecha             DATE NOT NULL,
  campo             TEXT NOT NULL,
  valor             NUMERIC(18,4) NOT NULL DEFAULT 0,
  ghl_user_id       TEXT,
  ghl_customer_id   TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_metricas_webhook_cuenta_fecha
  ON metricas_webhook (id_cuenta, fecha);
CREATE INDEX IF NOT EXISTS idx_metricas_webhook_user
  ON metricas_webhook (id_cuenta, ghl_user_id)
  WHERE ghl_user_id IS NOT NULL;
-- Índices únicos que exige el upsert del webhook (ver migración 044):
--   ON CONFLICT (id_cuenta, fecha, campo, ghl_user_id)  → fila por asesor
--   ON CONFLICT (id_cuenta, fecha, campo) WHERE ghl_user_id IS NULL → fila agregada
CREATE UNIQUE INDEX IF NOT EXISTS metricas_webhook_unique
  ON metricas_webhook (id_cuenta, fecha, campo, ghl_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_metricas_webhook_global
  ON metricas_webhook (id_cuenta, fecha, campo)
  WHERE ghl_user_id IS NULL;

-- ============================================================================
-- FIN — Tras ejecutar esto, arranca la app: las 56 migraciones quedarán
-- registradas como baseline y no se re-ejecutarán.
-- ============================================================================

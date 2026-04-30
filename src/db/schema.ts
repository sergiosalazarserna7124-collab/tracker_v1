import { pgTable, serial, bigserial, integer, text, timestamp, jsonb, boolean, date, unique, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Tabla principal de citas/agendas.
 * La columna fue renombrada de "fecha de la reunion" a "fecha_reunion"
 * y su tipo cambiado a TIMESTAMPTZ para soportar hora y zona horaria.
 */
export const agendas = pgTable("resumenes_diarios_agendas", {
  id_registro_agenda: serial("id_registro_agenda").primaryKey(),
  id_cuenta: integer("id_cuenta").notNull(),
  idcliente: text("idcliente"),
  ghl_contact_id: text("ghl_contact_id"),
  fecha: timestamp("fecha", { withTimezone: true }),
  nombre_de_lead: text("nombre_de_lead"),
  origen: text("origen"),
  email_lead: text("email_lead"),
  categoria: text("categoria"),
  closer: text("closer"),
  tags: text("tags"),
  fechaReunion: timestamp("fecha_reunion", { withTimezone: true }),
  // ── Campos de análisis de videollamada Fathom ──────────────────────────────
  cash_collected: text("cash_collected"),
  facturacion: text("facturacion"),
  resumen_ia: text("resumen_ia"),
  link_llamada: text("link_llamada"),
  objeciones_ia: jsonb("objeciones_ia"),
  reportmarketing: text("reportmarketing"),
  // ── V2: etiquetado interno omnicanal ──────────────────────────────────────
  tags_internos: jsonb("tags_internos"),
  // ── V5: trazabilidad de ingestión Fathom (recording_id dedupe) ────────────
  fathom_recording_id: text("fathom_recording_id"),
  fathom_share_url: text("fathom_share_url"),
  fathom_processed_at: timestamp("fathom_processed_at", { withTimezone: true }),
  fathom_ingestion_source: text("fathom_ingestion_source"),
}, (table) => [
  // ── Índices parciales para lookup en effectivePath() (categoria = PDTE) ──
  index("idx_agendas_cuenta_contact_pdte")
    .on(table.id_cuenta, table.ghl_contact_id)
    .where(sql`${table.categoria} = 'PDTE'`),
  index("idx_agendas_cuenta_email_pdte")
    .on(table.id_cuenta, sql`LOWER(${table.email_lead})`)
    .where(sql`${table.categoria} = 'PDTE'`),
]);

/**
 * Tabla de registros de llamadas telefónicas.
 * Nota: el campo `trancription` preserva el typo del nombre de columna en BD.
 */
export const llamadas = pgTable("registros_de_llamada", {
  id_registro: serial("id_registro").primaryKey(),
  fecha_evento: timestamp("fecha_evento", { withTimezone: true }),
  id_cuenta: integer("id_cuenta"),
  nombre_lead: text("nombre_lead"),
  estado: text("estado"),
  mail_lead: text("mail_lead"),
  phone_raw_format: text("phone_raw_format"),
  creativo_origen: text("creativo_origen"),
  closer_mail: text("closer_mail"),
  nombre_closer: text("nombre_closer"),
  fecha_y_hora_de_seguimiento: timestamp("fecha_y_hora_de_seguimiento", { withTimezone: true }),
  speed_to_lead: text("speed_to_lead"),
  intentos_contacto: integer("intentos_contacto").default(0),
  fecha_primera_llamada: timestamp("fecha_primera_llamada", { withTimezone: true }),
  trancription: text("trancription"),
  callsid: text("callsid"),
  iadescripcion: text("iadescripcion"),
  id_user_ghl: text("id_user_ghl"),
  ghl_contact_id: text("ghl_contact_id"),
  // ── V2: etiquetado interno omnicanal ──────────────────────────────────────
  tags_internos: jsonb("tags_internos"),
  // ── V4: resultado de clasificación del embudo personalizado por IA ─────────
  lead_embudo_personalizado: jsonb("lead_embudo_personalizado"),
});

/**
 * Tabla de historial inmutable de eventos de llamadas telefónicas.
 * Cada interacción (pdte, buzón, no_contesto, efectiva_*) genera una fila.
 * Nunca se edita, solo se inserta. Es el audit trail del proceso comercial.
 */
export const logLlamadas = pgTable("log_llamadas", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  id_registro: integer("id_registro"),
  id_cuenta: integer("id_cuenta").notNull(),
  mail_lead: text("mail_lead"),
  id_user_ghl: text("id_user_ghl"),
  contact_id_ghl: text("contact_id_ghl"),
  nombre_lead: text("nombre_lead"),
  phone: text("phone"),
  tipo_evento: text("tipo_evento").notNull(),
  estado_resultado: text("estado_resultado"),
  call_sid: text("call_sid"),
  transcripcion: text("transcripcion"),
  ia_descripcion: text("ia_descripcion"),
  closer_mail: text("closer_mail"),
  nombre_closer: text("nombre_closer"),
  creativo_origen: text("creativo_origen"),
  speed_to_lead: text("speed_to_lead"),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  // ── V2: etiquetado interno omnicanal ──────────────────────────────────────
  tags_internos: jsonb("tags_internos"),
  // ── V4: resultado de clasificación del embudo personalizado por IA ─────────
  lead_embudo_personalizado: jsonb("lead_embudo_personalizado"),
});

/**
 * Tabla maestra de cuentas/tenants.
 */
export const cuentas = pgTable("cuentas", {
  id_cuenta: serial("id_cuenta").primaryKey(),
  nombre_cuenta: text("nombre_cuenta"),
  id_cuenta_padre: integer("id_cuenta_padre"),
  identificador_url: text("identificador_url"),
  locationid: text("locationid"),
  token_ghl: text("token_ghl"),
  token_ghl_status: text("token_ghl_status").default("unknown"), // 'ok' | 'invalid' | 'unknown'
  prompt_ventas: text("prompt_ventas"),
  twilio_sid: text("twilio_sid"),
  auth_twilio: text("auth_twilio"),
  // ── V2: BYOK OpenAI, embudo dinámico y config de eventos ─────────────────
  openai_api_key: text("openai_api_key"),
  embudo_personalizado: jsonb("embudo_personalizado"),
  tipos_eventos_config: jsonb("tipos_eventos_config"),
  // ── V3: configuración de roles por tenant ─────────────────────────────────
  roles_config: jsonb("roles_config"),
  // ── V4: prompts específicos por canal + reglas de etiquetas ────────────────
  prompt_videollamadas: text("prompt_videollamadas"),
  prompt_llamadas: text("prompt_llamadas"),
  reglas_etiquetas: jsonb("reglas_etiquetas"),
  // ── V5: configuración de integraciones de Ads ─────────────────────────────
  configuracion_ads: jsonb("configuracion_ads"),
  // ── V6: métricas manuales y config ────────────────────────────────────────
  metricas_config: jsonb("metricas_config"),
  metricas_manual_data: jsonb("metricas_manual_data"),
});

// ── Tablas de ingesta externa ────────────────────────────────────────────────

export const kpisExternos = pgTable("kpis_externos", {
  id_registro: serial("id_registro").primaryKey(),
  id_cuenta: integer("id_cuenta").notNull(),
  fecha: date("fecha", { mode: "string" }).notNull(),
  origen: text("origen").default("api_externa"),
  metricas: jsonb("metricas").notNull().default({}),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const apiKeysCuenta = pgTable("api_keys_cuenta", {
  id_key: serial("id_key").primaryKey(),
  id_cuenta: integer("id_cuenta").notNull(),
  nombre_key: text("nombre_key").notNull(),
  token: text("token").unique().notNull(),
  activa: boolean("activa").default(true),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const usoApiMensual = pgTable("uso_api_mensual", {
  id_uso: serial("id_uso").primaryKey(),
  id_cuenta: integer("id_cuenta").notNull(),
  mes_anio: text("mes_anio").notNull(),
  tipo_consumo: text("tipo_consumo").notNull(),
  cantidad: integer("cantidad").default(0),
}, (t) => [
  unique().on(t.id_cuenta, t.mes_anio, t.tipo_consumo),
]);

// ── Tabla de eventos huérfanos (webhooks sin datos clave) ────────────────────

export const eventosHuerfanos = pgTable("eventos_huerfanos", {
  id_huerfano: serial("id_huerfano").primaryKey(),
  id_cuenta: integer("id_cuenta"),
  origen: text("origen").notNull(),
  motivo: text("motivo").notNull(),
  payload_original: jsonb("payload_original").notNull(),
  estado: text("estado").default("pendiente"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// ── Tabla de usuarios del dashboard (selección de API key Fathom) ────────────
export const usuariosDashboard = pgTable("usuarios_dashboard", {
  id_evento: text("id_evento").primaryKey(),
  id_cuenta: integer("id_cuenta").notNull(),
  fathom: text("fathom"),
});

// ── Tabla de tokens OAuth GHL Marketplace ────────────────────────────────────
export const ghlOauthTokens = pgTable("ghl_oauth_tokens", {
  id: serial("id").primaryKey(),
  location_id: text("location_id").notNull().unique(),
  id_cuenta: integer("id_cuenta").references(() => cuentas.id_cuenta, { onDelete: "set null" }),
  access_token: text("access_token").notNull(),
  refresh_token: text("refresh_token").notNull(),
  token_type: text("token_type").default("Bearer"),
  expires_in: integer("expires_in"),
  scope: text("scope"),
  installed_at: timestamp("installed_at", { withTimezone: true }).defaultNow(),
  last_refreshed_at: timestamp("last_refreshed_at", { withTimezone: true }).defaultNow(),
  expires_at: timestamp("expires_at", { withTimezone: true }),
  user_type: text("user_type"),
  company_id: text("company_id"),
});

// ── Tabla: acciones GHL pendientes por token inválido ─────────────────────────
export const ghlPendingActions = pgTable("ghl_pending_actions", {
  id: serial("id").primaryKey(),
  id_cuenta: integer("id_cuenta").references(() => cuentas.id_cuenta, { onDelete: "cascade" }).notNull(),
  contact_id: text("contact_id").notNull(),
  action_type: text("action_type").notNull(), // 'note' | 'tag' | 'tags'
  payload: jsonb("payload").notNull(),         // {body:...} para nota, {tag:...} o {tags:[...]} para tags
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  retry_count: integer("retry_count").default(0),
  last_error: text("last_error"),
  resolved_at: timestamp("resolved_at", { withTimezone: true }), // NULL = pendiente
});

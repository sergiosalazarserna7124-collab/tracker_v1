import { pgTable, serial, bigserial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";

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
});

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
  prompt_ventas: text("prompt_ventas"),
  twilio_sid: text("twilio_sid"),
  auth_twilio: text("auth_twilio"),
});

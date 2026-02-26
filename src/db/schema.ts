import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * Tabla principal de citas/agendas.
 * La columna "fecha de la reunion" tiene espacio; Drizzle lo mapea
 * desde el alias TypeScript `fechaReunion` al nombre real de la columna.
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
  fechaReunion: timestamp("fecha de la reunion", { withTimezone: true }),
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

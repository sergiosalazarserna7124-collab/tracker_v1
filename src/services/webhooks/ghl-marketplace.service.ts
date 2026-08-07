/**
 * Procesamiento de eventos del GHL Marketplace app (Fase 3).
 *
 * El endpoint /webhooks/ghl-marketplace registra TODOS los eventos en la tabla
 * shadow (observación). Aquí, además, procesamos los que ya migramos al pipeline
 * real. Se va habilitando canal por canal.
 *
 * Canal habilitado: CONTACTOS.
 *  - ContactCreate     → registra un "lead nuevo" en registros_de_llamada
 *                        (arranca el cronómetro speed-to-lead), salvo que el
 *                        contacto tenga la etiqueta de descarte.
 *  - ContactTagUpdate  → si se le agrega/quita la etiqueta de descarte, marca
 *                        el lead como excluido/incluido de métricas.
 *
 * Etiqueta de descarte: "no_trackearlead" (case-insensitive).
 */

import { db as pgPool } from "../../config/database.js";
import { getAccountByLocationId } from "../ghl-api.service.js";

const DISCARD_TAG = "no_trackearlead";

interface GhlContactEvent {
  type?: string;
  id?: string;
  locationId?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  tags?: string[];
  dateAdded?: string;
  [k: string]: unknown;
}

function hasDiscardTag(tags?: string[]): boolean {
  return (tags ?? []).some((t) => typeof t === "string" && t.trim().toLowerCase() === DISCARD_TAG);
}

function fullName(b: GhlContactEvent): string | null {
  const n = (b.name ?? [b.firstName, b.lastName].filter(Boolean).join(" ")).trim();
  return n || null;
}

/**
 * Registra el contacto como lead nuevo en registros_de_llamada si aún no existe.
 * Devuelve true si lo creó. Dedup por ghl_contact_id.
 */
async function registerNewLead(idCuenta: number, body: GhlContactEvent): Promise<boolean> {
  const contactId = body.id;
  if (!contactId) return false;

  const { rows } = await pgPool.query(
    `SELECT id_registro FROM registros_de_llamada WHERE id_cuenta = $1 AND ghl_contact_id = $2 LIMIT 1`,
    [idCuenta, contactId],
  );
  if (rows.length > 0) return false;

  const fecha = body.dateAdded ? new Date(body.dateAdded) : new Date();
  await pgPool.query(
    `INSERT INTO registros_de_llamada
       (fecha_evento, id_cuenta, nombre_lead, estado, mail_lead, phone_raw_format, ghl_contact_id, excluido_metricas)
     VALUES ($1, $2, $3, 'pdte', $4, $5, $6, false)`,
    [fecha, idCuenta, fullName(body), body.email ?? null, body.phone ?? null, contactId],
  );
  return true;
}

// ─── ContactCreate → lead nuevo ───────────────────────────────────────────────

async function handleContactCreate(body: GhlContactEvent): Promise<void> {
  const locationId = body.locationId;
  const contactId = body.id;
  if (!locationId || !contactId) return;

  const account = await getAccountByLocationId(locationId);
  if (!account) {
    console.warn(`[Marketplace/ContactCreate] Sin cuenta para location=${locationId}`);
    return;
  }
  const idCuenta = account.id_cuenta;

  // Etiqueta de descarte → no se trackea
  if (hasDiscardTag(body.tags)) {
    console.info(`[Marketplace/ContactCreate] Contacto ${contactId} con etiqueta "${DISCARD_TAG}" → no se trackea`);
    return;
  }

  const created = await registerNewLead(idCuenta, body);
  console.info(
    `[Marketplace/ContactCreate] Contacto=${contactId} cuenta=${idCuenta} → ${created ? "lead nuevo registrado" : "ya existía (skip)"}`,
  );
}

// ─── ContactTagUpdate → aplicar/quitar descarte ───────────────────────────────

async function handleContactTagUpdate(body: GhlContactEvent): Promise<void> {
  const locationId = body.locationId;
  const contactId = body.id;
  if (!locationId || !contactId) return;

  const account = await getAccountByLocationId(locationId);
  if (!account) return;
  const idCuenta = account.id_cuenta;

  const discarded = hasDiscardTag(body.tags);
  const calificacion = discarded ? "descartado" : null;

  // Excluir/incluir el lead en TODOS los canales. Cada uno filtra por su bandera:
  //  - llamadas (registros_de_llamada) → excluido_metricas
  //  - chats (chats_logs) y videollamadas/citas (resumenes_diarios_agendas) → excluida_dashboard
  // Reversible: al quitar la etiqueta se ponen en false/null y el lead reaparece.
  // Solo escribe en NUESTRA BD (no llama a GHL) → sin riesgo de bucle.
  const resLlamadas = await pgPool.query(
    `UPDATE registros_de_llamada SET excluido_metricas = $3, calificacion_manual = $4
     WHERE id_cuenta = $1 AND ghl_contact_id = $2`,
    [idCuenta, contactId, discarded, calificacion],
  );
  const resChats = await pgPool.query(
    `UPDATE chats_logs SET excluida_dashboard = $3, excluido_metricas = $3, calificacion_manual = $4
     WHERE id_cuenta = $1 AND id_lead = $2`,
    [idCuenta, contactId, discarded, calificacion],
  );
  const resAgendas = await pgPool.query(
    `UPDATE resumenes_diarios_agendas SET excluida_dashboard = $3
     WHERE id_cuenta = $1 AND ghl_contact_id = $2`,
    [idCuenta, contactId, discarded],
  );

  // Reactivación total: si se QUITÓ la etiqueta y el contacto no tiene registro
  // (p.ej. se creó ya descartado, o se limpió), crearlo ahora → "sin etiqueta = trackeado".
  let creado = false;
  if (!discarded) {
    creado = await registerNewLead(idCuenta, body);
  }

  const total = (resLlamadas.rowCount ?? 0) + (resChats.rowCount ?? 0) + (resAgendas.rowCount ?? 0);
  if (total > 0 || creado) {
    console.info(
      `[Marketplace/ContactTagUpdate] Contacto=${contactId} → descartado=${discarded} ` +
      `(llamadas=${resLlamadas.rowCount}, chats=${resChats.rowCount}, agendas=${resAgendas.rowCount}${creado ? ", lead creado" : ""})`,
    );
  }
}

// ─── Llamadas (mensajes de tipo CALL) ────────────────────────────────────────

interface GhlCallEvent extends GhlContactEvent {
  contactId?: string;
  messageId?: string;
  messageType?: string;
  status?: string | null;
  callStatus?: string | null;
  callDuration?: number | null;
  direction?: string;
  userId?: string | null;
  to?: string;
  from?: string;
  timestamp?: string;
}

/**
 * Mapea el estado de la llamada a los valores que entiende el dashboard.
 * GHL manda el resultado REAL en `status` (nivel superior); `callStatus` es
 * poco confiable (una llamada fallida puede traer callStatus="ringing").
 *  - contestada     → "efectiva_ghl" (esLlamadaContestada: startsWith "efectiva_")
 *  - no contestada  → "no_contesto" (no-answer / busy / failed / canceled)
 *  - en progreso    → "en_progreso" (in-progress / queued / initiated)
 */
function mapCallOutcome(status: string | null | undefined, callStatus: string | null | undefined): {
  tipo_evento: string;
  estado_resultado: string;
  finalizada: boolean;
} {
  const s = (status ?? callStatus ?? "").toLowerCase().trim();
  if (s === "completed") return { tipo_evento: "efectiva_ghl", estado_resultado: "completed", finalizada: true };
  if (s === "no-answer" || s === "noanswer") return { tipo_evento: "no_contesto", estado_resultado: "no-answer", finalizada: true };
  if (s === "busy") return { tipo_evento: "no_contesto", estado_resultado: "busy", finalizada: true };
  if (s === "failed") return { tipo_evento: "no_contesto", estado_resultado: "failed", finalizada: true };
  if (s === "canceled" || s === "cancelled") return { tipo_evento: "no_contesto", estado_resultado: "canceled", finalizada: true };
  // Estados realmente en vivo (llamada larga en curso) → aún no finalizó
  if (s === "in-progress" || s === "ringing" || s === "queued" || s === "initiated") {
    return { tipo_evento: "en_progreso", estado_resultado: s, finalizada: false };
  }
  // Desconocido/vacío → no contestada (fue un intento que no conectó)
  return { tipo_evento: "no_contesto", estado_resultado: s || "desconocido", finalizada: true };
}

async function handleCallEvent(body: GhlCallEvent): Promise<void> {
  if ((body.messageType ?? "").toUpperCase() !== "CALL") return; // solo llamadas, no SMS/otros
  const locationId = body.locationId;
  const contactId = body.contactId ?? body.id;
  const callSid = body.messageId;
  if (!locationId || !contactId || !callSid) return;

  const account = await getAccountByLocationId(locationId);
  if (!account) return;
  const idCuenta = account.id_cuenta;

  // Asegurar que el lead exista y obtener su id_registro (para VINCULAR la llamada).
  await registerNewLead(idCuenta, { ...body, id: contactId });
  const { rows: leadRows } = await pgPool.query<{ id_registro: number }>(
    `SELECT id_registro FROM registros_de_llamada WHERE id_cuenta = $1 AND ghl_contact_id = $2 ORDER BY id_registro DESC LIMIT 1`,
    [idCuenta, contactId],
  );
  const idRegistro = leadRows[0]?.id_registro ?? null;

  const { tipo_evento, estado_resultado, finalizada } = mapCallOutcome(body.status, body.callStatus);
  const ts = body.dateAdded ? new Date(body.dateAdded) : (body.timestamp ? new Date(body.timestamp) : new Date());
  const phone = body.direction === "inbound" ? (body.from ?? null) : (body.to ?? null);
  const duracion = typeof body.callDuration === "number" ? body.callDuration : null;

  // Upsert por call_sid (messageId): si GHL manda ringing → completed con el mismo id,
  // se actualiza al estado final; si es una llamada nueva, se inserta.
  const { rows: existing } = await pgPool.query(
    `SELECT id FROM log_llamadas WHERE id_cuenta = $1 AND call_sid = $2 LIMIT 1`,
    [idCuenta, callSid],
  );
  if (existing.length > 0) {
    await pgPool.query(
      `UPDATE log_llamadas SET tipo_evento = $3, estado_resultado = $4, duracion_segundos = COALESCE($5, duracion_segundos), ts = $6
       WHERE id_cuenta = $1 AND call_sid = $2`,
      [idCuenta, callSid, tipo_evento, estado_resultado, duracion, ts],
    );
  } else {
    await pgPool.query(
      `INSERT INTO log_llamadas
         (id_cuenta, id_registro, contact_id_ghl, phone, tipo_evento, estado_resultado, call_sid, ts, duracion_segundos, id_user_ghl)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [idCuenta, idRegistro, contactId, phone, tipo_evento, estado_resultado, callSid, ts, duracion, body.userId ?? null],
    );
  }

  // Si la llamada FINALIZÓ, marcar el primer contacto en el lead (sale de "pendientes por llamar").
  if (finalizada) {
    await pgPool.query(
      `UPDATE registros_de_llamada
         SET fecha_primera_llamada = COALESCE(fecha_primera_llamada, $3),
             estado = CASE WHEN UPPER(TRIM(estado)) = 'PDTE' THEN 'seguimiento' ELSE estado END
       WHERE id_cuenta = $1 AND ghl_contact_id = $2`,
      [idCuenta, contactId, ts],
    );
  }

  console.info(
    `[Marketplace/Call] contacto=${contactId} status=${body.status ?? body.callStatus ?? "null"} → ${tipo_evento}/${estado_resultado} dur=${duracion ?? "-"}s finalizada=${finalizada}`,
  );
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export async function handleMarketplaceEvent(
  eventType: string | null,
  body: unknown,
): Promise<void> {
  const b = (body ?? {}) as GhlCallEvent;
  switch (eventType) {
    case "ContactCreate":
      await handleContactCreate(b);
      break;
    case "ContactTagUpdate":
      await handleContactTagUpdate(b);
      break;
    case "OutboundMessage":
    case "InboundMessage":
      // Las llamadas telefónicas llegan como mensajes de tipo CALL.
      await handleCallEvent(b);
      break;
    default:
      // Otros eventos: por ahora solo shadow. Se habilitarán en fases siguientes.
      break;
  }
}

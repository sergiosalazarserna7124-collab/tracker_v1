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

  // Dedup: si ya existe un registro para este contacto, no duplicar
  const { rows: exists } = await pgPool.query(
    `SELECT id_registro FROM registros_de_llamada WHERE id_cuenta = $1 AND ghl_contact_id = $2 LIMIT 1`,
    [idCuenta, contactId],
  );
  if (exists.length > 0) {
    console.info(`[Marketplace/ContactCreate] Contacto ${contactId} ya registrado → skip`);
    return;
  }

  const fecha = body.dateAdded ? new Date(body.dateAdded) : new Date();
  await pgPool.query(
    `INSERT INTO registros_de_llamada
       (fecha_evento, id_cuenta, nombre_lead, estado, mail_lead, phone_raw_format, ghl_contact_id, excluido_metricas)
     VALUES ($1, $2, $3, 'pdte', $4, $5, $6, false)`,
    [fecha, idCuenta, fullName(body), body.email ?? null, body.phone ?? null, contactId],
  );
  console.info(`[Marketplace/ContactCreate] Lead nuevo registrado contacto=${contactId} cuenta=${idCuenta}`);
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
  const total = (resLlamadas.rowCount ?? 0) + (resChats.rowCount ?? 0) + (resAgendas.rowCount ?? 0);
  if (total > 0) {
    console.info(
      `[Marketplace/ContactTagUpdate] Contacto=${contactId} → descartado=${discarded} (llamadas=${resLlamadas.rowCount}, chats=${resChats.rowCount}, agendas=${resAgendas.rowCount})`,
    );
  }
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export async function handleMarketplaceEvent(
  eventType: string | null,
  body: unknown,
): Promise<void> {
  const b = (body ?? {}) as GhlContactEvent;
  switch (eventType) {
    case "ContactCreate":
      await handleContactCreate(b);
      break;
    case "ContactTagUpdate":
      await handleContactTagUpdate(b);
      break;
    default:
      // Otros eventos: por ahora solo shadow. Se habilitarán en fases siguientes.
      break;
  }
}

import { db } from "../../config/database.js";
import { parseFechaReunionToUTC } from "../../utils/date.utils.js";
import { getAccountByLocationId, addContactTag, GHL_TAGS } from "../ghl-api.service.js";
import type { GhlWebhookPayload, GhlBodyPayload } from "../../schemas/webhooks/ghl.schema.js";
import type { ServiceResult } from "../../types/index.js";

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface AgendaResult {
  id_registro_agenda: number;
  categoria: string;
  action: "created" | "updated";
  tagged: boolean;
}

// ─── Helper: extraer campos normalizados del payload ─────────────────────────

function extractFields(body: GhlBodyPayload) {
  const cd = body.customData;

  // locationid: campo directo en body, o fallback a body.location.id (additionalProperties)
  const locationRaw = body.locationid?.trim() || (body as Record<string, unknown>).location;
  const locationId =
    typeof locationRaw === "string"
      ? locationRaw
      : typeof locationRaw === "object" && locationRaw !== null
        ? String((locationRaw as Record<string, unknown>).id ?? "")
        : "";

  const idCuenta = parseInt(cd.idcuenta, 10);
  if (isNaN(idCuenta) || idCuenta <= 0) {
    throw new Error(`GHL webhook: idcuenta inválido → "${cd.idcuenta}"`);
  }

  return {
    idCuenta,
    idcliente: cd.idcliente?.trim() || null,
    contactId: body.contact_id?.trim() || null,
    locationId: locationId || null,
    nombreLead:
      cd.nombre?.trim() || body.first_name?.trim() || body.full_name?.trim() || "sin nombre",
    emailLead: body.email?.trim() || cd.email?.trim() || null,
    origen: cd.origen?.trim() || "sin especificar",
    closer: cd.closer?.trim() ?? null,
    fechaReunion: parseFechaReunionToUTC(cd.hora, cd.zonahoraria),
  };
}

// ─── Helper: buscar registro existente ───────────────────────────────────────
// Prioridad 1: idcliente + id_cuenta
// Prioridad 2: email_lead + id_cuenta (fallback temporal)

async function findAgenda(
  idCuenta: number,
  idcliente: string | null,
  emailLead: string | null,
): Promise<number | null> {
  if (idcliente) {
    const { rows } = await db.query<{ id_registro_agenda: number }>(
      `SELECT id_registro_agenda
       FROM resumenes_diarios_agendas
       WHERE idcliente = $1 AND id_cuenta = $2
       ORDER BY fecha DESC LIMIT 1`,
      [idcliente, idCuenta],
    );
    if (rows.length > 0) return rows[0].id_registro_agenda;
  }

  if (emailLead) {
    const { rows } = await db.query<{ id_registro_agenda: number }>(
      `SELECT id_registro_agenda
       FROM resumenes_diarios_agendas
       WHERE email_lead = $1 AND id_cuenta = $2
       ORDER BY fecha DESC LIMIT 1`,
      [emailLead, idCuenta],
    );
    if (rows.length > 0) return rows[0].id_registro_agenda;
  }

  return null;
}

// ─── Helper: INSERT nuevo registro ───────────────────────────────────────────

async function insertAgenda(
  fields: ReturnType<typeof extractFields>,
  categoria: string,
): Promise<number> {
  const { rows } = await db.query<{ id_registro_agenda: number }>(
    `INSERT INTO resumenes_diarios_agendas
       (id_cuenta, idcliente, ghl_contact_id, fecha, nombre_de_lead, origen, email_lead, categoria, closer, "fecha de la reunion")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id_registro_agenda`,
    [
      fields.idCuenta,
      fields.idcliente,
      fields.contactId,
      new Date(),
      fields.nombreLead,
      fields.origen,
      fields.emailLead,
      categoria,
      fields.closer,
      fields.fechaReunion,
    ],
  );
  return rows[0].id_registro_agenda;
}

// ─── Helper: aplicar tag en GHL (no-blocking) ────────────────────────────────
// Si falta locationId o contactId se omite en silencio.
// Si la API falla se loguea el error pero NO propaga la excepción,
// para que un fallo de tagging nunca rompa la operación de BD.

async function applyGhlTag(
  locationId: string | null,
  contactId: string | null,
  tag: string,
): Promise<boolean> {
  if (!locationId || !contactId) return false;

  try {
    const account = await getAccountByLocationId(locationId);
    if (!account) {
      console.warn(`[GHL tag] No se encontró cuenta para locationId="${locationId}"`);
      return false;
    }
    if (!account.token_ghl) {
      console.warn(`[GHL tag] La cuenta ${account.id_cuenta} no tiene token_ghl configurado`);
      return false;
    }

    await addContactTag(contactId, account.token_ghl, tag);
    return true;
  } catch (err) {
    console.error(`[GHL tag] Error al aplicar tag "${tag}" al contacto "${contactId}":`, err);
    return false;
  }
}

// ─── Handlers por categoría ──────────────────────────────────────────────────

async function handlePendiente(body: GhlBodyPayload): Promise<AgendaResult> {
  const fields = extractFields(body);

  const id = await insertAgenda(fields, "PDTE");
  const tagged = await applyGhlTag(fields.locationId, fields.contactId, GHL_TAGS.pendiente);

  return { id_registro_agenda: id, categoria: "PDTE", action: "created", tagged };
}

async function handleCancelada(body: GhlBodyPayload): Promise<AgendaResult> {
  const fields = extractFields(body);

  const existingId = await findAgenda(fields.idCuenta, fields.idcliente, fields.emailLead);

  let id: number;
  let action: "created" | "updated";

  if (existingId !== null) {
    await db.query(
      `UPDATE resumenes_diarios_agendas
       SET categoria = 'CANCELADA'
       WHERE id_registro_agenda = $1`,
      [existingId],
    );
    id = existingId;
    action = "updated";
  } else {
    id = await insertAgenda(fields, "CANCELADA");
    action = "created";
  }

  const tagged = await applyGhlTag(fields.locationId, fields.contactId, GHL_TAGS.cancelada);

  return { id_registro_agenda: id, categoria: "CANCELADA", action, tagged };
}

async function handleReagenda(body: GhlBodyPayload): Promise<AgendaResult> {
  const fields = extractFields(body);

  const existingId = await findAgenda(fields.idCuenta, fields.idcliente, fields.emailLead);

  let id: number;
  let action: "created" | "updated";

  if (existingId !== null) {
    await db.query(
      `UPDATE resumenes_diarios_agendas
       SET categoria = 'PDTE', "fecha de la reunion" = $2
       WHERE id_registro_agenda = $1`,
      [existingId, fields.fechaReunion],
    );
    id = existingId;
    action = "updated";
  } else {
    id = await insertAgenda(fields, "PDTE");
    action = "created";
  }

  const tagged = await applyGhlTag(fields.locationId, fields.contactId, GHL_TAGS.reagenda);

  return { id_registro_agenda: id, categoria: "PDTE", action, tagged };
}

// ─── Dispatcher principal ─────────────────────────────────────────────────────

export async function processGhlWebhook(
  payload: GhlWebhookPayload,
): Promise<ServiceResult<AgendaResult>> {
  const event = payload[0];
  const body = event.body;
  const categoria = body.customData.categoria?.toLowerCase().trim();

  switch (categoria) {
    case "pendiente":
      return { success: true, data: await handlePendiente(body) };

    case "cancelada":
      return { success: true, data: await handleCancelada(body) };

    case "reagenda":
      return { success: true, data: await handleReagenda(body) };

    default:
      return { success: true, data: undefined };
  }
}

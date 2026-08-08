import { db } from "../../config/database.js";
import { parseFechaReunionToUTC } from "../../utils/date.utils.js";
import { getAccountByLocationId, addContactTag, GHL_TAGS, getContactAppointmentDate } from "../ghl-api.service.js";
import { withRetry } from "../../utils/retry.utils.js";
import type { GhlBodyPayload } from "../../schemas/webhooks/ghl.schema.js";
import type { ServiceResult } from "../../types/index.js";

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface AgendaResult {
  id_registro_agenda: number;
  id_cuenta?: number | null;
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

  // Appointment owner: el email del closer/asesor asignado a la CITA (no al contacto)
  // GHL puede mandarlo con distintos nombres de campo — leer en orden de prioridad
  const bodyRaw = body as Record<string, unknown>;
  const cdRaw = cd as Record<string, unknown>;
  const appointmentOwnerEmail: string | null =
    // Campos más específicos primero (appointment owner)
    (typeof cdRaw.appointmentowneremail === "string" ? cdRaw.appointmentowneremail.trim() : null) ||
    (typeof cdRaw.appointment_owner_email === "string" ? cdRaw.appointment_owner_email.trim() : null) ||
    (typeof cdRaw.appointmentowner === "string" ? cdRaw.appointmentowner.trim() : null) ||
    (typeof cdRaw.closermail === "string" ? cdRaw.closermail.trim() : null) ||
    // Fallback: el campo closer genérico
    (typeof cd.closer === "string" ? cd.closer.trim() : null) ||
    // Fallback: user del body de GHL
    (bodyRaw.user && typeof bodyRaw.user === "object" && typeof (bodyRaw.user as Record<string, unknown>).email === "string"
      ? ((bodyRaw.user as Record<string, unknown>).email as string).trim()
      : null) ||
    null;

  return {
    idCuenta,
    idcliente: cd.idcliente?.trim() || null,
    contactId: body.contact_id?.trim() || null,
    locationId: locationId || null,
    nombreLead:
      cd.nombre?.trim() || body.first_name?.trim() || body.full_name?.trim() || "sin nombre",
    emailLead: body.email?.trim() || cd.email?.trim() || null,
    origen: cd.origen?.trim() || "sin especificar",
    closer: appointmentOwnerEmail,
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
    const { rows } = await withRetry(
      () =>
        db.query<{ id_registro_agenda: number }>(
          `SELECT id_registro_agenda
           FROM resumenes_diarios_agendas
           WHERE idcliente = $1 AND id_cuenta = $2
           ORDER BY fecha DESC LIMIT 1`,
          [idcliente, idCuenta],
        ),
      { label: "findAgenda/idcliente" },
    );
    if (rows.length > 0) return rows[0].id_registro_agenda;
  }

  if (emailLead) {
    const { rows } = await withRetry(
      () =>
        db.query<{ id_registro_agenda: number }>(
          `SELECT id_registro_agenda
           FROM resumenes_diarios_agendas
           WHERE email_lead = $1 AND id_cuenta = $2
           ORDER BY fecha DESC LIMIT 1`,
          [emailLead, idCuenta],
        ),
      { label: "findAgenda/email" },
    );
    if (rows.length > 0) return rows[0].id_registro_agenda;
  }

  return null;
}

// ─── Helper: buscar registro por contacto + fecha (evita duplicados de GHL) ──
// GHL puede disparar el mismo webhook pendiente N veces para el mismo contacto
// y fecha de reunión. Antes de insertar, verificamos si ya existe uno ese día.

async function findAgendaForDate(
  idCuenta: number,
  ghlContactId: string | null,
  idcliente: string | null,
  fechaReunion: Date | null,
): Promise<number | null> {
  // Necesitamos al menos un identificador de contacto y una fecha para deduplicar
  const contactKey = ghlContactId || idcliente;
  if (!contactKey || !fechaReunion) return null;

  const { rows } = await withRetry(
    () =>
      db.query<{ id_registro_agenda: number }>(
        `SELECT id_registro_agenda
         FROM resumenes_diarios_agendas
         WHERE id_cuenta = $1
           AND (ghl_contact_id = $2 OR idcliente = $2)
           AND CAST(fecha_reunion AS date) = CAST($3 AS date)
         ORDER BY fecha DESC LIMIT 1`,
        [idCuenta, contactKey, fechaReunion],
      ),
    { label: "findAgendaForDate" },
  );

  return rows.length > 0 ? rows[0].id_registro_agenda : null;
}

// ─── Helper: INSERT nuevo registro ───────────────────────────────────────────

async function insertAgenda(
  fields: ReturnType<typeof extractFields>,
  categoria: string,
): Promise<number> {
  const payload = {
    id_cuenta: fields.idCuenta,
    idcliente: fields.idcliente,
    ghl_contact_id: fields.contactId,
    fecha: new Date(),
    nombre_de_lead: fields.nombreLead,
    origen: fields.origen,
    email_lead: fields.emailLead,
    categoria,
    closer: fields.closer,
    fecha_de_la_reunion: fields.fechaReunion,
  };

  console.log("📦 Payload para BD (resumenes_diarios_agendas):", JSON.stringify(payload, null, 2));
  console.log("⏳ Iniciando db.query INSERT...");

  let result: number;
  try {
    const { rows } = await withRetry(
      () =>
        db.query<{ id_registro_agenda: number }>(
          `INSERT INTO resumenes_diarios_agendas
             (id_cuenta, idcliente, ghl_contact_id, fecha, nombre_de_lead, origen, email_lead, categoria, closer, fecha_reunion)
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
        ),
      { label: "insertAgenda" },
    );

    result = rows[0].id_registro_agenda;
    console.log("✅ Insert exitoso en BD. id_registro_agenda:", result);
  } catch (dbErr) {
    console.error("❌ ERROR FATAL EN BASE DE DATOS (INSERT):", dbErr);
    throw dbErr;
  }

  return result;
}

// ─── Helper: aplicar tag en GHL — totalmente aislado ────────────────────────
// NUNCA propaga excepciones. Un fallo de GHL (401, timeout, red) solo loguea
// y devuelve false. El guardado en BD ya ocurrió antes de llamar aquí.

async function applyGhlTag(
  locationId: string | null,
  contactId: string | null,
  tag: string,
  context: string,
): Promise<boolean> {
  if (!locationId || !contactId) return false;

  try {
    const account = await getAccountByLocationId(locationId);
    if (!account) {
      console.warn(`[GHL tag][${context}] No se encontró cuenta para locationId="${locationId}"`);
      return false;
    }
    if (!account.token_ghl) {
      console.warn(
        `[GHL tag][${context}] La cuenta ${account.id_cuenta} no tiene token_ghl configurado`,
      );
      return false;
    }

    await addContactTag(contactId, account.token_ghl, tag);
    return true;
  } catch (err) {
    console.error(
      `[GHL tag][${context}] Error al aplicar tag "${tag}" al contacto "${contactId}":`,
      err,
    );
    return false;
  }
}

// ─── Handlers por categoría ──────────────────────────────────────────────────
// Patrón: DB primero (crítico) → GHL después (best-effort, nunca bloquea).

async function handlePendiente(body: GhlBodyPayload, tokenGhl?: string): Promise<AgendaResult> {
  const fields = extractFields(body);

  // Fallback: si hora/zonahoraria no vinieron en el payload, consultar GHL por la cita real
  if (!fields.fechaReunion && fields.contactId && tokenGhl) {
    const apptDate = await getContactAppointmentDate(fields.contactId, tokenGhl, new Date());
    if (apptDate) {
      fields.fechaReunion = apptDate;
      console.info(`[GHL handlePendiente] fechaReunion tomada de GHL appointments: ${apptDate.toISOString()}`);
    }
  }

  // Deduplicación: GHL puede disparar el webhook "pendiente" múltiples veces para la
  // misma cita. Si tenemos fecha_reunion, buscamos por (contacto + día exacto) —
  // más preciso que solo por contacto. Si no hay fecha, caemos al findAgenda clásico.
  const existingId = fields.fechaReunion
    ? await findAgendaForDate(fields.idCuenta, fields.contactId, fields.idcliente, fields.fechaReunion)
    : await findAgenda(fields.idCuenta, fields.idcliente, fields.emailLead);

  let id: number;
  let action: "created" | "updated";

  if (existingId !== null) {
    console.info(
      `[GHL handlePendiente] Duplicado ignorado — ya existe id_registro_agenda=${existingId} para contacto=${fields.contactId} fecha=${fields.fechaReunion?.toISOString()}`,
    );
    // Actualizar fecha_reunion por si cambió (reagenda) pero mismo contacto+día
    try {
      await withRetry(
        () =>
          db.query(
            `UPDATE resumenes_diarios_agendas
             SET categoria = 'PDTE', fecha_reunion = COALESCE($2, fecha_reunion)
             WHERE id_registro_agenda = $1`,
            [existingId, fields.fechaReunion],
          ),
        { label: "handlePendiente/update-dedup" },
      );
    } catch (dbErr) {
      console.error("❌ ERROR FATAL EN BASE DE DATOS (UPDATE pendiente dedup):", dbErr);
      throw dbErr;
    }
    id = existingId;
    action = "updated";
  } else {
    // Verificar si hay un no_show previo del mismo contacto antes de insertar
    let noShowId: number | null = null;
    if (fields.contactId) {
      try {
        const { rows: noShowRows } = await db.query<{ id_registro_agenda: number }>(
          `SELECT id_registro_agenda FROM resumenes_diarios_agendas
           WHERE id_cuenta = $1 AND ghl_contact_id = $2
             AND categoria = 'no_show'
           ORDER BY fecha_reunion DESC LIMIT 1`,
          [fields.idCuenta, fields.contactId],
        );
        noShowId = noShowRows.length > 0 ? noShowRows[0].id_registro_agenda : null;
      } catch (dbErr) {
        console.error("ERROR en lookup no_show (handlePendiente):", dbErr);
        noShowId = null; // fallback: continuar con insert normal
      }
    }

    if (noShowId !== null) {
      // Reutilizar registro: resetear a PDTE con nueva fecha
      await withRetry(
        () =>
          db.query(
            `UPDATE resumenes_diarios_agendas
             SET categoria = 'PDTE',
                 fecha_reunion = COALESCE($2, fecha_reunion),
                 fecha = NOW()
             WHERE id_registro_agenda = $1`,
            [noShowId, fields.fechaReunion],
          ),
        { label: "handlePendiente/reuse-noshow" },
      );
      id = noShowId;
      action = "updated";
      console.info(
        `[GHL handlePendiente] No-show previo reutilizado — id=${noShowId}, contacto=${fields.contactId}`,
      );
    } else {
      id = await insertAgenda(fields, "PDTE");
      action = "created";
    }
  }

  // Decisión de producto: las citas solo etiquetan el no-show (no_show_lm).
  const tagged = false;

  return { id_registro_agenda: id, categoria: "PDTE", action, tagged };
}

async function handleCancelada(body: GhlBodyPayload): Promise<AgendaResult> {
  const fields = extractFields(body);

  const existingId = await findAgenda(fields.idCuenta, fields.idcliente, fields.emailLead);
  let id: number;
  let action: "created" | "updated";

  if (existingId !== null) {
    console.log("⏳ Iniciando db.query UPDATE (cancelada)... id_registro_agenda:", existingId);
    try {
      await withRetry(
        () =>
          db.query(
            `UPDATE resumenes_diarios_agendas
             SET categoria = 'CANCELADA'
             WHERE id_registro_agenda = $1`,
            [existingId],
          ),
        { label: "handleCancelada/update" },
      );
      console.log("✅ Update exitoso en BD. id_registro_agenda:", existingId);
    } catch (dbErr) {
      console.error("❌ ERROR FATAL EN BASE DE DATOS (UPDATE cancelada):", dbErr);
      throw dbErr;
    }
    id = existingId;
    action = "updated";
  } else {
    id = await insertAgenda(fields, "CANCELADA");
    action = "created";
  }

  // Decisión de producto: las citas solo etiquetan el no-show (no_show_lm).
  const tagged = false;

  return { id_registro_agenda: id, categoria: "CANCELADA", action, tagged };
}

async function handleReagenda(body: GhlBodyPayload, tokenGhl?: string): Promise<AgendaResult> {
  const fields = extractFields(body);

  // Same GHL fallback as handlePendiente: fetch real appointment date if not in payload
  if (!fields.fechaReunion && fields.contactId && tokenGhl) {
    const apptDate = await getContactAppointmentDate(fields.contactId, tokenGhl, new Date());
    if (apptDate) {
      fields.fechaReunion = apptDate;
      console.info(`[GHL handleReagenda] fechaReunion tomada de GHL appointments: ${apptDate.toISOString()}`);
    }
  }

  const existingId = await findAgenda(fields.idCuenta, fields.idcliente, fields.emailLead);
  let id: number;
  let action: "created" | "updated";

  if (existingId !== null) {
    console.log("⏳ Iniciando db.query UPDATE (reagenda)... id_registro_agenda:", existingId);
    try {
      await withRetry(
        () =>
          db.query(
            // Use COALESCE to never overwrite a valid fecha_reunion with NULL
            `UPDATE resumenes_diarios_agendas
             SET categoria = 'PDTE', fecha_reunion = COALESCE($2, fecha_reunion)
             WHERE id_registro_agenda = $1`,
            [existingId, fields.fechaReunion],
          ),
        { label: "handleReagenda/update" },
      );
      console.log("✅ Update exitoso en BD. id_registro_agenda:", existingId);
    } catch (dbErr) {
      console.error("❌ ERROR FATAL EN BASE DE DATOS (UPDATE reagenda):", dbErr);
      throw dbErr;
    }
    id = existingId;
    action = "updated";
  } else {
    id = await insertAgenda(fields, "PDTE");
    action = "created";
  }

  // Decisión de producto: las citas solo etiquetan el no-show (no_show_lm).
  const tagged = false;

  return { id_registro_agenda: id, categoria: "PDTE", action, tagged };
}

// ─── Handler: lead perdido ──────────────────────────────────────────────────

async function handlePerdido(body: GhlBodyPayload): Promise<AgendaResult> {
  const fields = extractFields(body);

  let updatedChats = 0;
  let updatedLlamadas = 0;

  if (fields.contactId) {
    const { rowCount } = await withRetry(
      () =>
        db.query(
          `UPDATE chats_logs
           SET estado = 'perdido'
           WHERE id_cuenta = $1 AND id_lead = $2 AND estado <> 'perdido'`,
          [fields.idCuenta, fields.contactId],
        ),
      { label: "handlePerdido/chats" },
    );
    updatedChats = rowCount ?? 0;
  }

  if (fields.contactId) {
    const { rowCount } = await withRetry(
      () =>
        db.query(
          `UPDATE registros_de_llamada
           SET estado = 'perdido'
           WHERE id_cuenta = $1 AND ghl_contact_id = $2
             AND estado NOT IN ('venta','ganado','ganada','perdido','perdida','cerrado','cerrada')`,
          [fields.idCuenta, fields.contactId],
        ),
      { label: "handlePerdido/llamadas" },
    );
    updatedLlamadas = rowCount ?? 0;
  }

  console.log(
    `[GHL handlePerdido] cuenta=${fields.idCuenta} contacto=${fields.contactId} ` +
    `→ chats=${updatedChats} llamadas=${updatedLlamadas}`,
  );

  // ── AUT-1061: capturar razón de pérdida y guardar en razones_perdida_data ──
  await appendRazonPerdida(body, fields);

  // Decisión de producto: las citas solo etiquetan el no-show (no_show_lm).
  const tagged = false;

  return {
    id_registro_agenda: 0,
    categoria: "perdido",
    action: "updated",
    tagged,
  };
}

// ─── Handler: descartar lead (excluir de dashboard + métricas) ──────────────

async function handleDescartar(body: GhlBodyPayload): Promise<AgendaResult> {
  const fields = extractFields(body);

  let updatedChats = 0;
  let updatedLlamadas = 0;

  if (fields.contactId) {
    const chatResult = await withRetry(
      () =>
        db.query(
          `UPDATE chats_logs
           SET excluida_dashboard = true, excluido_metricas = true, calificacion_manual = 'descartado'
           WHERE id_cuenta = $1 AND id_lead = $2 AND (excluida_dashboard = false OR excluido_metricas = false OR calificacion_manual IS DISTINCT FROM 'descartado')`,
          [fields.idCuenta, fields.contactId],
        ),
      { label: "handleDescartar/chats" },
    );
    updatedChats = chatResult.rowCount ?? 0;

    const llamadaResult = await withRetry(
      () =>
        db.query(
          `UPDATE registros_de_llamada
           SET excluido_metricas = true, calificacion_manual = 'descartado'
           WHERE id_cuenta = $1::text AND ghl_contact_id = $2 AND (excluido_metricas = false OR calificacion_manual IS DISTINCT FROM 'descartado')`,
          [String(fields.idCuenta), fields.contactId],
        ),
      { label: "handleDescartar/llamadas" },
    );
    updatedLlamadas = llamadaResult.rowCount ?? 0;
  }

  console.log(
    `[GHL handleDescartar] cuenta=${fields.idCuenta} contacto=${fields.contactId} ` +
    `→ chats_excluidos=${updatedChats} llamadas_excluidas=${updatedLlamadas}`,
  );

  const tagged = await applyGhlTag(
    fields.locationId,
    fields.contactId,
    GHL_TAGS.descartar,
    "handleDescartar",
  );

  return {
    id_registro_agenda: 0,
    categoria: "descartar",
    action: "updated",
    tagged,
  };
}

// ─── Helper: append razón de pérdida a cuentas.razones_perdida_data ─────────

async function appendRazonPerdida(
  body: GhlBodyPayload,
  fields: ReturnType<typeof extractFields>,
): Promise<void> {
  const cdRaw = body.customData as Record<string, unknown>;

  const razonId =
    (typeof cdRaw.razon_perdida === "string" ? cdRaw.razon_perdida.trim() : null) ||
    (typeof cdRaw.razon_perdida_id === "string" ? cdRaw.razon_perdida_id.trim() : null) ||
    (typeof cdRaw.loss_reason === "string" ? cdRaw.loss_reason.trim() : null);

  if (!razonId) {
    console.info(
      `[GHL handlePerdido] Sin razón de pérdida en customData — cuenta=${fields.idCuenta} contacto=${fields.contactId}`,
    );
    return;
  }

  const notas =
    (typeof cdRaw.razon_perdida_notas === "string" ? cdRaw.razon_perdida_notas.trim() : null) ||
    (typeof cdRaw.loss_reason_notes === "string" ? cdRaw.loss_reason_notes.trim() : null) ||
    null;

  const entry = {
    razon_id: razonId,
    contact_id: fields.contactId ?? undefined,
    contact_name: fields.nombreLead !== "sin nombre" ? fields.nombreLead : undefined,
    closer_email: fields.closer ?? undefined,
    fecha: new Date().toISOString(),
    notas: notas ?? undefined,
  };

  try {
    await withRetry(
      () =>
        db.query(
          `UPDATE cuentas
           SET razones_perdida_data = COALESCE(razones_perdida_data, '[]'::jsonb) || $2::jsonb
           WHERE id_cuenta = $1`,
          [fields.idCuenta, JSON.stringify([entry])],
        ),
      { label: "appendRazonPerdida" },
    );
    console.log(
      `[GHL handlePerdido] Razón de pérdida guardada — cuenta=${fields.idCuenta} razon_id="${razonId}"`,
    );
  } catch (err) {
    console.error(
      `[GHL handlePerdido] Error al guardar razón de pérdida — cuenta=${fields.idCuenta}:`,
      err,
    );
  }
}

// ─── Dispatcher principal ─────────────────────────────────────────────────────

export async function processGhlWebhook(
  body: GhlBodyPayload,
): Promise<ServiceResult<AgendaResult>> {
  try {
    // ── Rayos X: imprimir el payload completo tal como llegó al servicio ──────
    console.log("🔍 [GHL webhook] Payload completo recibido:");
    console.log(JSON.stringify(body, null, 2));

    const categoriaRaw = body.customData?.categoria;
    const categoria = categoriaRaw?.toLowerCase().trim();

    console.log(
      `🔍 [GHL webhook] customData.categoria RAW → "${categoriaRaw}" | normalizado → "${categoria}"`,
    );

    // Validar que id_cuenta exista en tabla cuentas y no esté cancelada
    const idCuentaRaw = parseInt(body.customData?.idcuenta, 10);
    if (!isNaN(idCuentaRaw) && idCuentaRaw > 0) {
      try {
        const { rows: cuentaRows } = await db.query<{ id_cuenta: number; estado_cuenta: string | null }>(
          `SELECT id_cuenta, estado_cuenta FROM cuentas WHERE id_cuenta = $1 LIMIT 1`,
          [idCuentaRaw],
        );
        if (cuentaRows.length === 0) {
          console.warn(
            `⚠️ [GHL webhook] id_cuenta=${idCuentaRaw} NO existe en tabla cuentas. ` +
            `El webhook se procesará pero los datos quedarán huérfanos. ` +
            `locationId="${body.locationid?.trim() || ""}" categoria="${categoria}"`,
          );
        } else if (cuentaRows[0].estado_cuenta === "cancelado") {
          console.info(
            `[GHL webhook] Cuenta cancelada id=${idCuentaRaw} — webhook descartado silenciosamente. ` +
            `locationId="${body.locationid?.trim() || ""}" categoria="${categoria}"`,
          );
          return { success: true };
        }
      } catch (validationErr) {
        console.warn(`⚠️ [GHL webhook] No se pudo validar id_cuenta=${idCuentaRaw} contra tabla cuentas:`, validationErr);
      }
    }

    // Obtener token GHL para fallback de appointments (best-effort)
    let tokenGhl: string | undefined;
    try {
      const idCuenta = parseInt(body.customData?.idcuenta, 10);
      if (!isNaN(idCuenta)) {
        const locationId = body.locationid?.trim() || "";
        const account = await getAccountByLocationId(locationId);
        tokenGhl = account?.token_ghl ?? undefined;
      }
    } catch { /* best-effort */ }

    const idCuentaGhl = !isNaN(idCuentaRaw) && idCuentaRaw > 0 ? idCuentaRaw : null;

    switch (categoria) {
      case "pendiente": {
        console.log("🔀 [GHL webhook] Entrando a handlePendiente");
        const data = await handlePendiente(body, tokenGhl);
        return { success: true, data: { ...data, id_cuenta: idCuentaGhl } };
      }

      case "cancelada": {
        console.log("🔀 [GHL webhook] Entrando a handleCancelada");
        const data = await handleCancelada(body);
        return { success: true, data: { ...data, id_cuenta: idCuentaGhl } };
      }

      case "reagenda": {
        console.log("🔀 [GHL webhook] Entrando a handleReagenda");
        const data = await handleReagenda(body, tokenGhl);
        return { success: true, data: { ...data, id_cuenta: idCuentaGhl } };
      }

      case "perdido": {
        console.log("🔀 [GHL webhook] Entrando a handlePerdido");
        const data = await handlePerdido(body);
        return { success: true, data: { ...data, id_cuenta: idCuentaGhl } };
      }

      case "descartar": {
        console.log("🔀 [GHL webhook] Entrando a handleDescartar");
        const data = await handleDescartar(body);
        return { success: true, data: { ...data, id_cuenta: idCuentaGhl } };
      }

      default:
        console.warn(
          `⚠️ [GHL webhook] Categoría no reconocida → "${categoria}" (raw: "${categoriaRaw}"). No se hará ninguna acción en BD.`,
        );
        return { success: true, data: undefined };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("❌ ERROR FATAL EN BASE DE DATOS:", err);
    return { success: false, error: message };
  }
}

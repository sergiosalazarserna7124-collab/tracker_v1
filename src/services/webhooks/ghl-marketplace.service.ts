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
 *                        contacto tenga la etiqueta de NO-TRACKEO.
 *  - ContactTagUpdate  → si se le agrega/quita una etiqueta de descarte, marca
 *                        el lead como excluido/incluido de métricas.
 *  - ContactUpdate     → sincroniza los datos del contacto (nombre, email,
 *                        teléfono, usuario asignado) hacia el dashboard.
 *  - Appointment*      → sincroniza citas (fecha/hora, owner y estado_cita:
 *                        confirmada/cancelada/reagendada) en agendas; Fathom
 *                        luego sobreescribe el resultado de la reunión.
 *  - In/OutboundMessage→ mensajes CALL → pipeline de llamadas; el resto
 *                        (Custom/SMS/WhatsApp/IG/FB…) → pipeline de chats.
 *
 * Dos etiquetas de descarte (case-insensitive), con semántica distinta:
 *  - "no_trackearlead" → NO se trackea: se oculta del dashboard
 *                        (excluida_dashboard) y sale de métricas. Como si no
 *                        existiera.
 *  - "descartar-lead"  → se DESCARTA pero sigue VISIBLE: sale de las métricas
 *                        globales (excluido_metricas) y queda marcado como
 *                        'descartado' (calificacion_manual) para poder contarlo
 *                        en la métrica de "leads descartados". No se oculta.
 * Ambas son reversibles: al quitar la etiqueta el lead vuelve a métricas.
 */

import { db as pgPool } from "../../config/database.js";
import {
  getAccountByLocationId,
  getAccountFullByLocationId,
  getGhlUser,
  safeAddContactTag,
  removeContactTag,
  addContactNote,
  updateContactEmail,
} from "../ghl-api.service.js";
import { getAccessToken } from "../oauth/ghl-oauth.service.js";
import { generateLlamadaAnalysisText, extractLlamadaObjections } from "../ai/call-analysis.service.js";
import { processChatWebhook } from "./chat.service.js";
import type { ChatWebhookBody } from "../../schemas/webhooks/chat.schema.js";
import { transcribeAudio } from "../ai/call-classification.service.js";

const TAG_EN_PROGRESO = "llamada-en-progreso";

/**
 * Trae la transcripción de una llamada desde GHL (add-on de transcripción).
 * GHL la genera con un pequeño delay → reintenta mientras venga vacía. Si tras
 * los reintentos sigue vacía, se asume que no se habló nada (wordCount 0).
 * Devuelve { formatted, wordCount }.
 */
async function getCallTranscript(
  locationId: string,
  messageId: string,
  token: string,
): Promise<{ formatted: string; wordCount: number }> {
  const url = `https://services.leadconnectorhq.com/conversations/locations/${locationId}/messages/${messageId}/transcription`;
  for (let intento = 0; intento < 5; intento++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Version: "2021-04-15", Accept: "application/json" },
      });
      if (res.ok) {
        const segs = (await res.json()) as Array<{ speaker?: number; transcript?: string }>;
        if (Array.isArray(segs) && segs.length > 0) {
          const raw = segs.map((s) => (s.transcript ?? "").trim()).filter(Boolean).join(" ");
          const wordCount = raw ? raw.split(/\s+/).filter(Boolean).length : 0;
          const formatted = segs
            .map((s) => `Speaker ${s.speaker ?? "?"}: ${(s.transcript ?? "").trim()}`)
            .filter((l) => l.length > 12)
            .join("\n");
          return { formatted, wordCount };
        }
      }
    } catch { /* reintentar */ }
    await new Promise((r) => setTimeout(r, 7000)); // esperar a que GHL genere el transcript
  }
  return { formatted: "", wordCount: 0 }; // no hubo conversación (o no hay transcript)
}

// Etiqueta de NO-TRACKEO: oculta del dashboard + fuera de métricas.
const DISCARD_TAG = "no_trackearlead";
// Etiqueta de DESCARTE: sigue visible, pero fuera de métricas globales y
// marcado como 'descartado' (cuenta en la métrica de leads descartados).
const DESCARTAR_TAG = "descartar-lead";

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
  assignedTo?: string;
  dateAdded?: string;
  [k: string]: unknown;
}

function hasDiscardTag(tags?: string[]): boolean {
  return (tags ?? []).some((t) => typeof t === "string" && t.trim().toLowerCase() === DISCARD_TAG);
}

function hasDescartarTag(tags?: string[]): boolean {
  return (tags ?? []).some((t) => typeof t === "string" && t.trim().toLowerCase() === DESCARTAR_TAG);
}

// Etiqueta puesta por un workflow nativo de GHL (trigger "Call Status") cuando
// una llamada NO es contestada. Existe porque el webhook OutboundMessage del
// marketplace solo se dispara para completed/failed — no-answer/busy/voicemail
// nunca llegan por webhook. Acepta variantes de separador (espacio/guión).
const TAG_NO_CONTESTADA = "no_contesta_call";

function normalizeTag(t: string): string {
  return t.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function hasNoContestadaTag(tags?: string[]): boolean {
  return (tags ?? []).some((t) => typeof t === "string" && normalizeTag(t) === TAG_NO_CONTESTADA);
}

// Etiquetas FINANCIERAS (las pone el equipo en el contacto):
//  - "apartado" → el lead apartó: cuenta 1 apartado y suma el campo custom de
//    la oportunidad "Monto de apartado".
//  - "compro"   → venta: cuenta 1 venta y suma el value (monetaryValue) de la
//    oportunidad. Acepta acentos/mayúsculas ("Compró" → compro).
const TAG_APARTADO = "apartado";
const TAG_COMPRO = "compro";

function sinAcentos(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function tieneEtiqueta(tags: string[] | undefined, objetivo: string): boolean {
  return (tags ?? []).some((t) => typeof t === "string" && sinAcentos(normalizeTag(t)) === objetivo);
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
  const { rows: ins } = await pgPool.query<{ id_registro: number }>(
    `INSERT INTO registros_de_llamada
       (fecha_evento, id_cuenta, nombre_lead, estado, mail_lead, phone_raw_format, ghl_contact_id, excluido_metricas)
     VALUES ($1, $2, $3, 'pdte', $4, $5, $6, false)
     RETURNING id_registro`,
    [fecha, idCuenta, fullName(body), body.email ?? null, body.phone ?? null, contactId],
  );
  const idRegistro = ins[0]?.id_registro;

  // Evento "contacto_creado" en log_llamadas → cuenta como "Lead generado" en el panel.
  if (idRegistro) {
    await pgPool.query(
      `INSERT INTO log_llamadas
         (id_cuenta, id_registro, contact_id_ghl, mail_lead, phone, nombre_lead, tipo_evento, ts)
       VALUES ($1, $2, $3, $4, $5, $6, 'contacto_creado', $7)`,
      [idCuenta, idRegistro, contactId, body.email ?? null, body.phone ?? null, fullName(body), fecha],
    );
  }
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

  // Etiqueta de NO-TRACKEO → ni se registra (queda oculto)
  if (hasDiscardTag(body.tags)) {
    console.info(`[Marketplace/ContactCreate] Contacto ${contactId} con etiqueta "${DISCARD_TAG}" → no se trackea`);
    return;
  }

  const created = await registerNewLead(idCuenta, body);

  // Etiqueta de DESCARTE → sí se registra (visible), pero marcado como
  // descartado y fuera de métricas globales desde el nacimiento del lead.
  if (created && hasDescartarTag(body.tags)) {
    await pgPool.query(
      `UPDATE registros_de_llamada SET excluido_metricas = true, calificacion_manual = 'descartado'
       WHERE id_cuenta = $1 AND ghl_contact_id = $2`,
      [idCuenta, contactId],
    );
    console.info(`[Marketplace/ContactCreate] Contacto=${contactId} cuenta=${idCuenta} → lead registrado como DESCARTADO (visible)`);
    return;
  }

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

  // Llamada no contestada reportada vía etiqueta (workflow "Call Status").
  if (hasNoContestadaTag(body.tags)) {
    await handleNoContestadaTag(idCuenta, locationId, body);
  }

  // Etiquetas financieras: apartado / compro → marcar la oportunidad del contacto.
  try {
    await handleEtiquetasFinancieras(
      idCuenta,
      locationId,
      contactId,
      tieneEtiqueta(body.tags, TAG_APARTADO),
      tieneEtiqueta(body.tags, TAG_COMPRO),
    );
  } catch (e) {
    console.warn(`[Marketplace/Finanzas] error procesando etiquetas de ${contactId}:`, e instanceof Error ? e.message : e);
  }

  // Dos etiquetas, semántica distinta:
  //  - no_trackearlead → oculto del dashboard + fuera de métricas.
  //  - descartar-lead  → fuera de métricas pero SIGUE VISIBLE (no se oculta).
  const noTrackear = hasDiscardTag(body.tags);
  const descartar = hasDescartarTag(body.tags);
  const excluido = noTrackear || descartar;          // fuera de métricas en ambos casos
  const oculto = noTrackear;                          // solo no-trackeo oculta del dashboard
  // Calificación DISTINTA por etiqueta — un no-trackeado NO es un descartado:
  //  - 'descartado'   → era un lead real que no compró: cuenta como lead y suma
  //                     en la métrica "Leads descartados".
  //  - 'no_trackeado' → nunca fue un lead (amigo del cliente, consulta random):
  //                     desaparece de TODAS las métricas, incluida la de descartados.
  const calificacion = noTrackear ? "no_trackeado" : descartar ? "descartado" : null;

  // Excluir/incluir el lead en TODOS los canales. Cada uno filtra por su bandera:
  //  - llamadas (registros_de_llamada) → excluido_metricas (esta tabla no se oculta)
  //  - chats (chats_logs) → excluido_metricas + excluida_dashboard (solo si no-trackeo)
  //  - videollamadas/citas (resumenes_diarios_agendas) → excluida_dashboard (solo no-trackeo)
  // Reversible: al quitar ambas etiquetas se ponen en false/null y el lead reaparece.
  // Solo escribe en NUESTRA BD (no llama a GHL) → sin riesgo de bucle.
  const resLlamadas = await pgPool.query(
    `UPDATE registros_de_llamada SET excluido_metricas = $3, calificacion_manual = $4
     WHERE id_cuenta = $1 AND ghl_contact_id = $2`,
    [idCuenta, contactId, excluido, calificacion],
  );
  const resChats = await pgPool.query(
    `UPDATE chats_logs SET excluida_dashboard = $3, excluido_metricas = $4, calificacion_manual = $5
     WHERE id_cuenta = $1 AND id_lead = $2`,
    [idCuenta, contactId, oculto, excluido, calificacion],
  );
  const resAgendas = await pgPool.query(
    `UPDATE resumenes_diarios_agendas SET excluida_dashboard = $3
     WHERE id_cuenta = $1 AND ghl_contact_id = $2`,
    [idCuenta, contactId, oculto],
  );

  // Con descartar-lead (o sin etiquetas), el lead debe estar VISIBLE. Si no tiene
  // registro (se creó ya descartado, o se limpió), crearlo ahora. En el caso de
  // descarte, dejarlo marcado como descartado tras crearlo.
  let creado = false;
  if (!oculto) {
    creado = await registerNewLead(idCuenta, body);
    if (creado && descartar) {
      await pgPool.query(
        `UPDATE registros_de_llamada SET excluido_metricas = true, calificacion_manual = 'descartado'
         WHERE id_cuenta = $1 AND ghl_contact_id = $2`,
        [idCuenta, contactId],
      );
    }
  }

  const total = (resLlamadas.rowCount ?? 0) + (resChats.rowCount ?? 0) + (resAgendas.rowCount ?? 0);
  if (total > 0 || creado) {
    const estado = noTrackear ? "no_trackeado(oculto)" : descartar ? "descartado(visible)" : "incluido";
    console.info(
      `[Marketplace/ContactTagUpdate] Contacto=${contactId} → ${estado} ` +
      `(llamadas=${resLlamadas.rowCount}, chats=${resChats.rowCount}, agendas=${resAgendas.rowCount}${creado ? ", lead creado" : ""})`,
    );
  }
}

// ─── Etiqueta "no-contestada" → registrar intento de llamada ──────────────────

/**
 * Registra una llamada no contestada reportada por el workflow de GHL vía la
 * etiqueta "no-contestada", con el mismo efecto que handleCallEvent para un
 * status no-answer: fila en log_llamadas + primera llamada + salida de
 * "pendientes por llamar". Al final QUITA la etiqueta del contacto para que
 * el próximo no-answer del workflow la vuelva a poner y re-dispare el evento.
 * Quitar la etiqueta re-emite ContactTagUpdate sin ella → no hay bucle.
 */
async function handleNoContestadaTag(
  idCuenta: number,
  locationId: string,
  body: GhlContactEvent,
): Promise<void> {
  const contactId = body.id;
  if (!contactId) return;
  const rawTs = (body as Record<string, unknown>).timestamp;
  const ts = typeof rawTs === "string" ? new Date(rawTs) : new Date();

  // Dedup: GHL puede re-emitir ContactTagUpdate con la etiqueta aún puesta
  // (p.ej. otro tag cambió antes de que alcanzáramos a quitarla). Dos intentos
  // reales al mismo lead en <90s es prácticamente imposible.
  const { rows: recent } = await pgPool.query(
    `SELECT 1 FROM log_llamadas
     WHERE id_cuenta = $1 AND contact_id_ghl = $2 AND tipo_evento = 'no_contesto'
       AND ts > NOW() - INTERVAL '90 seconds' LIMIT 1`,
    [idCuenta, contactId],
  );

  if (recent.length === 0) {
    await registerNewLead(idCuenta, body);
    const { rows: leadRows } = await pgPool.query<{ id_registro: number }>(
      `SELECT id_registro FROM registros_de_llamada WHERE id_cuenta = $1 AND ghl_contact_id = $2 ORDER BY id_registro DESC LIMIT 1`,
      [idCuenta, contactId],
    );
    const webhookId = (body as Record<string, unknown>).webhookId;
    await pgPool.query(
      `INSERT INTO log_llamadas
         (id_cuenta, id_registro, contact_id_ghl, phone, nombre_lead, tipo_evento, estado_resultado, call_sid, ts)
       VALUES ($1, $2, $3, $4, $5, 'no_contesto', 'no-answer', $6, $7)`,
      [
        idCuenta,
        leadRows[0]?.id_registro ?? null,
        contactId,
        body.phone ?? null,
        fullName(body),
        `tag:${typeof webhookId === "string" ? webhookId : ts.getTime()}`,
        ts,
      ],
    );
    await pgPool.query(
      `UPDATE registros_de_llamada
         SET fecha_primera_llamada = COALESCE(fecha_primera_llamada, $3),
             estado = CASE WHEN UPPER(TRIM(estado)) = 'PDTE' THEN 'seguimiento' ELSE estado END
       WHERE id_cuenta = $1 AND ghl_contact_id = $2`,
      [idCuenta, contactId, ts],
    );
    console.info(`[Marketplace/NoContestadaTag] contacto=${contactId} cuenta=${idCuenta} → no_contesto registrado`);
  }

  // Quitar la etiqueta SIEMPRE (aunque se haya deduplicado) para rearmar el
  // trigger del workflow. Best-effort: si falla, el dedup de 90s protege.
  try {
    const token = await getAccessToken(locationId);
    if (token) await removeContactTag(contactId, token, TAG_NO_CONTESTADA);
  } catch (e) {
    console.warn(`[Marketplace/NoContestadaTag] no se pudo quitar la etiqueta de ${contactId}:`, e instanceof Error ? e.message : e);
  }
}

// ─── Etiquetas financieras: apartado / compro → oportunidad del contacto ─────

const CUSTOM_FIELD_MONTO_APARTADO = "monto de apartado";
// Cache por location del id del campo custom (se resuelve una vez por proceso).
const cfMontoApartadoCache = new Map<string, string | null>();

async function getMontoApartadoFieldId(locationId: string, token: string): Promise<string | null> {
  const cached = cfMontoApartadoCache.get(locationId);
  if (cached !== undefined) return cached;
  let id: string | null = null;
  try {
    const res = await fetch(
      `https://services.leadconnectorhq.com/locations/${locationId}/customFields?model=opportunity`,
      { headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" } },
    );
    if (res.ok) {
      const data = (await res.json()) as { customFields?: Array<{ id?: string; name?: string }> };
      const match = (data.customFields ?? []).find(
        (f) => sinAcentos((f.name ?? "").trim().toLowerCase()) === CUSTOM_FIELD_MONTO_APARTADO,
      );
      id = match?.id ?? null;
    }
  } catch (e) {
    console.warn(`[Marketplace/Finanzas] no se pudo resolver campo custom en ${locationId}:`, e instanceof Error ? e.message : e);
    return null; // no cachear el fallo
  }
  cfMontoApartadoCache.set(locationId, id);
  if (!id) console.warn(`[Marketplace/Finanzas] location ${locationId} no tiene el campo custom "Monto de apartado" en oportunidades`);
  return id;
}

interface GhlOpportunitySearchItem {
  id?: string;
  name?: string;
  status?: string;
  monetaryValue?: number;
  createdAt?: string;
  updatedAt?: string;
  customFields?: Array<{ id?: string; fieldValue?: unknown; field_value?: unknown }>;
}

/**
 * Marca apartado/venta en la oportunidad del contacto según las etiquetas.
 *  - apartado: monto desde el campo custom "Monto de apartado" de la oportunidad.
 *  - compro:   monto desde el value (monetaryValue) de la oportunidad.
 * fecha_apartado/fecha_venta se setean la PRIMERA vez (no se pisan en re-eventos)
 * y se limpian si la etiqueta se quita (corrección reversible).
 */
async function handleEtiquetasFinancieras(
  idCuenta: number,
  locationId: string,
  contactId: string,
  apartado: boolean,
  compro: boolean,
): Promise<void> {
  if (!apartado && !compro) {
    // Reversión: el contacto ya no tiene las etiquetas → limpiar flags si los tenía.
    const res = await pgPool.query(
      `UPDATE oportunidades SET apartado = false, fecha_apartado = NULL, venta = false, fecha_venta = NULL
       WHERE id_cuenta = $1 AND ghl_contact_id = $2 AND (apartado OR venta)`,
      [idCuenta, contactId],
    );
    if (res.rowCount) console.info(`[Marketplace/Finanzas] contacto=${contactId} sin etiquetas → apartado/venta revertidos (${res.rowCount})`);
    return;
  }

  const token = await getAccessToken(locationId);
  if (!token) return;

  // Oportunidad más reciente (no borrada) del contacto
  const res = await fetch(
    `https://services.leadconnectorhq.com/opportunities/search?location_id=${encodeURIComponent(locationId)}&contact_id=${encodeURIComponent(contactId)}`,
    { headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" } },
  );
  if (!res.ok) {
    console.warn(`[Marketplace/Finanzas] búsqueda de oportunidades HTTP ${res.status} contacto=${contactId}`);
    return;
  }
  const data = (await res.json()) as { opportunities?: GhlOpportunitySearchItem[] };
  const opp = (data.opportunities ?? [])
    .filter((o) => o.id && (o.status ?? "") !== "deleted")
    .sort((a, b) => new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() - new Date(a.updatedAt ?? a.createdAt ?? 0).getTime())[0];
  if (!opp?.id) {
    console.warn(`[Marketplace/Finanzas] contacto=${contactId} con etiqueta ${apartado ? "apartado" : "compro"} pero SIN oportunidad en GHL — no se puede contar`);
    return;
  }

  // Monto apartado: campo custom "Monto de apartado" de la oportunidad
  let montoApartado: number | null = null;
  if (apartado) {
    const fieldId = await getMontoApartadoFieldId(locationId, token);
    const cf = fieldId ? (opp.customFields ?? []).find((f) => f.id === fieldId) : undefined;
    const raw = cf?.fieldValue ?? cf?.field_value;
    const num = raw != null ? parseFloat(String(raw).replace(/[^0-9.\-]/g, "")) : NaN;
    montoApartado = Number.isFinite(num) ? num : null;
    if (montoApartado == null) {
      console.warn(`[Marketplace/Finanzas] oportunidad ${opp.id} sin valor en "Monto de apartado" — apartado cuenta con monto 0`);
    }
  }
  const monetary = typeof opp.monetaryValue === "number" ? opp.monetaryValue : null;
  const montoVenta = compro ? monetary : null;

  await pgPool.query(
    `INSERT INTO oportunidades
       (id_cuenta, ghl_opportunity_id, ghl_contact_id, nombre, status, monetary_value, fecha_creada, fecha_actualizada,
        apartado, monto_apartado, fecha_apartado, venta, monto_venta, fecha_venta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(),
             $8, $9, CASE WHEN $8::boolean THEN NOW() END, $10, $11, CASE WHEN $10::boolean THEN NOW() END)
     ON CONFLICT (id_cuenta, ghl_opportunity_id) DO UPDATE SET
       apartado          = EXCLUDED.apartado,
       monto_apartado    = COALESCE(EXCLUDED.monto_apartado, oportunidades.monto_apartado),
       fecha_apartado    = CASE WHEN EXCLUDED.apartado THEN COALESCE(oportunidades.fecha_apartado, NOW()) ELSE NULL END,
       venta             = EXCLUDED.venta,
       monto_venta       = COALESCE(EXCLUDED.monto_venta, oportunidades.monto_venta),
       fecha_venta       = CASE WHEN EXCLUDED.venta THEN COALESCE(oportunidades.fecha_venta, NOW()) ELSE NULL END,
       monetary_value    = COALESCE(EXCLUDED.monetary_value, oportunidades.monetary_value),
       fecha_actualizada = NOW()`,
    [idCuenta, opp.id, contactId, opp.name ?? null, opp.status ?? null, monetary,
     opp.createdAt ? new Date(opp.createdAt) : new Date(), apartado, montoApartado, compro, montoVenta],
  );
  console.info(
    `[Marketplace/Finanzas] contacto=${contactId} opp=${opp.id} → apartado=${apartado}` +
    `${apartado ? ` ($${montoApartado ?? 0})` : ""} venta=${compro}${compro ? ` ($${montoVenta ?? 0})` : ""}`,
  );
}

// ─── ContactUpdate → sincronizar datos del contacto en el dashboard ──────────

/**
 * Cuando un contacto se edita en GHL (manual o automáticamente), propaga los
 * cambios de identidad al dashboard: nombre, email, teléfono y usuario asignado.
 *
 * Se actualizan las tablas de ESTADO ACTUAL que el dashboard muestra:
 *  - registros_de_llamada (match por ghl_contact_id)
 *  - resumenes_diarios_agendas (match por ghl_contact_id)
 *  - chats_logs (match por id_lead)
 * NO se toca log_llamadas: es un histórico inmutable por-llamada (el closer de
 * cada llamada es quien la hizo, no debe reescribirse al reasignar el contacto).
 *
 * Se usa COALESCE para no borrar un dato existente si GHL no envía ese campo.
 * El usuario asignado (assignedTo) se resuelve a email+nombre vía la API de GHL
 * y solo se escribe si la resolución tiene éxito (para no perder atribución).
 */
async function handleContactUpdate(body: GhlContactEvent): Promise<void> {
  const locationId = body.locationId;
  const contactId = body.id;
  if (!locationId || !contactId) return;

  const account = await getAccountByLocationId(locationId);
  if (!account) return;
  const idCuenta = account.id_cuenta;

  const nombre = fullName(body);
  const email = body.email ?? null;
  const phone = body.phone ?? null;

  // Resolver el usuario asignado (assignedTo → email + nombre). Best-effort.
  const assignedTo = typeof body.assignedTo === "string" ? body.assignedTo : null;
  let closerMail: string | null = null;
  let closerNombre: string | null = null;
  if (assignedTo) {
    try {
      const token = await getAccessToken(locationId);
      if (token) {
        const user = await getGhlUser(assignedTo, token);
        closerMail = user?.email ?? null;
        closerNombre = user?.name ?? null;
      }
    } catch (e) {
      console.warn(`[Marketplace/ContactUpdate] no se pudo resolver usuario asignado ${assignedTo}:`, e instanceof Error ? e.message : e);
    }
  }

  // ── Identidad (nombre/email/phone) + fecha_asignacion en registros ──
  // fecha_asignacion se (re)setea a NOW() cuando el asesor asignado CAMBIA
  // (nuevo closer distinto al actual) → base del "speed to lead asesor".
  const resLlamadas = await pgPool.query(
    `UPDATE registros_de_llamada SET
       nombre_lead      = COALESCE($3, nombre_lead),
       mail_lead        = COALESCE($4, mail_lead),
       phone_raw_format = COALESCE($5, phone_raw_format),
       fecha_asignacion = CASE
         WHEN $6::text IS NOT NULL AND closer_mail IS DISTINCT FROM $6::text THEN NOW()
         ELSE fecha_asignacion END,
       closer_mail      = COALESCE($6, closer_mail),
       nombre_closer    = COALESCE($7, nombre_closer)
     WHERE id_cuenta = $1 AND ghl_contact_id = $2`,
    [idCuenta, contactId, nombre, email, phone, closerMail, closerNombre],
  );
  const resAgendas = await pgPool.query(
    `UPDATE resumenes_diarios_agendas SET
       nombre_de_lead = COALESCE($3, nombre_de_lead),
       email_lead     = COALESCE($4, email_lead),
       closer         = COALESCE($5, closer)
     WHERE id_cuenta = $1 AND ghl_contact_id = $2`,
    [idCuenta, contactId, nombre, email, closerMail ?? closerNombre],
  );
  const resChats = await pgPool.query(
    `UPDATE chats_logs SET
       nombre_lead     = COALESCE($3, nombre_lead),
       asesor_asignado = COALESCE($4, asesor_asignado)
     WHERE id_cuenta = $1 AND id_lead = $2`,
    [idCuenta, contactId, nombre, closerNombre ?? closerMail],
  );

  const total = (resLlamadas.rowCount ?? 0) + (resAgendas.rowCount ?? 0) + (resChats.rowCount ?? 0);
  if (total > 0) {
    console.info(
      `[Marketplace/ContactUpdate] Contacto=${contactId} sincronizado ` +
      `(llamadas=${resLlamadas.rowCount}, agendas=${resAgendas.rowCount}, chats=${resChats.rowCount})` +
      `${closerMail || closerNombre ? ` asignado=${closerMail ?? closerNombre}` : ""}`,
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
  if (s === "failed") return { tipo_evento: "fallida", estado_resultado: "failed", finalizada: true };
  if (s === "canceled" || s === "cancelled") return { tipo_evento: "fallida", estado_resultado: "canceled", finalizada: true };
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

  // El lead sale de "pendientes por llamar" solo si hubo un intento que CONECTÓ.
  // CUALQUIER evento de llamada (contestada, no contestada, buzón, fallida, o
  // incluso "en curso") marca el PRIMER intento: setea fecha_primera_llamada
  // (base del speed to lead) y saca el lead de "pendientes por llamar". No depende
  // de cómo GHL clasifique el status → sin margen de error. COALESCE mantiene la
  // primera llamada; el estado solo avanza si estaba en 'pdte'.
  await pgPool.query(
    `UPDATE registros_de_llamada
       SET fecha_primera_llamada = COALESCE(fecha_primera_llamada, $3),
           estado = CASE WHEN UPPER(TRIM(estado)) = 'PDTE' THEN 'seguimiento' ELSE estado END
     WHERE id_cuenta = $1 AND ghl_contact_id = $2`,
    [idCuenta, contactId, ts],
  );

  console.info(
    `[Marketplace/Call] contacto=${contactId} status=${body.status ?? body.callStatus ?? "null"} → ${tipo_evento}/${estado_resultado} dur=${duracion ?? "-"}s finalizada=${finalizada}`,
  );

  // ── Enriquecimiento (best-effort, no bloquea): asesor + tag en progreso + transcript/IA ──
  try {
    const token = await getAccessToken(locationId);
    if (!token) return;

    // 1. Atribuir la llamada al ASESOR (resolver el userId de GHL → email/nombre)
    if (body.userId) {
      try {
        const user = await getGhlUser(body.userId, token);
        const email = user?.email ?? null;
        const nombre = user?.name ?? null;
        if (email || nombre) {
          await pgPool.query(
            `UPDATE log_llamadas SET closer_mail = $3, nombre_closer = $4 WHERE id_cuenta = $1 AND call_sid = $2`,
            [idCuenta, callSid, email, nombre],
          );
          if (idRegistro) {
            await pgPool.query(
              `UPDATE registros_de_llamada SET closer_mail = COALESCE(closer_mail, $2), nombre_closer = COALESCE(nombre_closer, $3) WHERE id_registro = $1`,
              [idRegistro, email, nombre],
            );
          }
        }
      } catch (e) { console.warn(`[Marketplace/Call] no se pudo resolver asesor:`, e instanceof Error ? e.message : e); }
    }

    // 2. Etiqueta provisional "llamada-en-progreso": se pone si está en curso, se quita al finalizar
    try {
      if (!finalizada) await safeAddContactTag(contactId, token, TAG_EN_PROGRESO, locationId);
      else await removeContactTag(contactId, token, TAG_EN_PROGRESO);
    } catch (e) { console.warn(`[Marketplace/Call] tag en-progreso:`, e instanceof Error ? e.message : e); }

    // 3. Transcript → RE-EVALUAR el resultado real de una llamada "completed":
    //    - 0 palabras (nadie habló) → NO contestada
    //    - < 10 palabras (buzón/contestadora) → buzón, SIN análisis IA
    //    - ≥ 10 palabras (conversación real) → efectiva + análisis IA + nota en GHL
    if (finalizada && tipo_evento.startsWith("efectiva")) {
      const { formatted: transcript, wordCount } = await getCallTranscript(locationId, callSid, token);

      if (wordCount === 0) {
        await pgPool.query(
          `UPDATE log_llamadas SET tipo_evento = 'no_contesto', estado_resultado = 'sin_conversacion' WHERE id_cuenta = $1 AND call_sid = $2`,
          [idCuenta, callSid],
        );
        console.info(`[Marketplace/Call] call=${callSid} 0 palabras (nadie habló) → no_contesto`);
      } else if (wordCount < 10) {
        await pgPool.query(
          `UPDATE log_llamadas SET tipo_evento = 'buzon', estado_resultado = 'buzon_voz', transcripcion = $3 WHERE id_cuenta = $1 AND call_sid = $2`,
          [idCuenta, callSid, transcript],
        );
        console.info(`[Marketplace/Call] call=${callSid} ${wordCount} palabras → buzón/contestadora (sin IA)`);
      } else {
        const acc = await getAccountFullByLocationId(locationId);
        const promptVentas = acc?.prompt_ventas ?? null;
        const promptLlamadas = acc?.prompt_llamadas ?? null;
        const openaiKey = acc?.openai_api_key ?? null;

        const analysis = await generateLlamadaAnalysisText(transcript, promptVentas, promptLlamadas, openaiKey, idCuenta).catch(() => null);
        const objeciones = await extractLlamadaObjections(transcript, promptVentas, openaiKey, idCuenta).catch(() => null);

        await pgPool.query(
          `UPDATE log_llamadas SET transcripcion = $3, ia_descripcion = COALESCE($4, ia_descripcion) WHERE id_cuenta = $1 AND call_sid = $2`,
          [idCuenta, callSid, transcript, analysis],
        );
        if (idRegistro) {
          await pgPool.query(
            `UPDATE registros_de_llamada SET trancription = $2, iadescripcion = COALESCE($3, iadescripcion), ia_objeciones = COALESCE($4::jsonb, ia_objeciones) WHERE id_registro = $1`,
            [idRegistro, transcript, analysis, objeciones ? JSON.stringify(objeciones) : null],
          );
        }
        const nota = `📞 Llamada — Análisis IA\n\n${analysis ?? "(sin análisis)"}\n\n———\n📝 Transcripción:\n${transcript}`;
        await addContactNote(contactId, token, nota).catch(() => {});
        console.info(`[Marketplace/Call] call=${callSid} ${wordCount} palabras → efectiva + IA + nota`);
      }
    }
  } catch (err) {
    console.error(`[Marketplace/Call] enriquecimiento error:`, err instanceof Error ? err.message : err);
  }
}

// ─── Citas (AppointmentCreate / AppointmentUpdate / AppointmentDelete) ────────

interface GhlAppointmentPayload {
  id?: string;
  contactId?: string;
  startTime?: string;
  endTime?: string;
  assignedUserId?: string;
  appointmentStatus?: string;
  title?: string;
  calendarId?: string;
  dateAdded?: string;
  dateUpdated?: string;
}
interface GhlAppointmentEvent {
  locationId?: string;
  appointment?: GhlAppointmentPayload;
}

/**
 * Mapea el estado de agendamiento de GHL → estado_cita del dashboard.
 * `isReagenda` = cita existente cuyo horario (startTime) cambió sin cancelarse.
 */
function mapAppointmentEstado(status: string | undefined, isReagenda: boolean): string {
  const s = (status ?? "").toLowerCase().trim();
  if (s === "cancelled" || s === "canceled") return "cancelada";
  if (s === "noshow" || s === "no-show" || s === "no_show") return "no_show";
  if (s === "showed") return "asistida";
  if (isReagenda) return "reagendada";
  if (s === "confirmed") return "confirmada";
  return "confirmada"; // "new"/agendada → confirmada por defecto
}

/**
 * Sincroniza una cita de GHL hacia resumenes_diarios_agendas.
 *  - fecha_reunion = startTime (fecha + hora de la cita)
 *  - closer        = owner (assignedUserId resuelto a email/nombre)
 *  - estado_cita   = confirmada/cancelada/reagendada/no_show/asistida
 *  - categoria     = se mantiene compatible con el pipeline: 'cancelada'/'no_show'
 *                    para el dashboard, y 'PDTE' mientras la reunión no ocurre
 *                    (así asistencia y Fathom pueden actualizarla). NUNCA pisa un
 *                    resultado ya puesto por Fathom (fathom_recording_id != null),
 *                    salvo cancelación.
 * Match por ghl_appointment_id → detecta reagendas y evita duplicar.
 */
async function handleAppointment(eventType: string, body: GhlAppointmentEvent): Promise<void> {
  const locationId = body.locationId;
  const appt = body.appointment;
  if (!locationId || !appt?.id) return;

  const account = await getAccountByLocationId(locationId);
  if (!account) return;
  const idCuenta = account.id_cuenta;

  const apptId = appt.id;
  const contactId = appt.contactId ?? null;
  const startTime = appt.startTime ? new Date(appt.startTime) : null;
  const isDelete = eventType === "AppointmentDelete";
  const isCancel = isDelete || (appt.appointmentStatus ?? "").toLowerCase().includes("cancel");

  // Token una sola vez (para resolver owner + escribir email sintético).
  let token: string | null = null;
  try { token = await getAccessToken(locationId); } catch { /* best-effort */ }

  // Owner de la cita → email/nombre (best-effort).
  let closer: string | null = null;
  if (appt.assignedUserId && token) {
    try {
      const user = await getGhlUser(appt.assignedUserId, token);
      closer = user?.email ?? user?.name ?? null;
    } catch (e) {
      console.warn(`[Marketplace/Appointment] no se pudo resolver owner ${appt.assignedUserId}:`, e instanceof Error ? e.message : e);
    }
  }

  // Datos del lead (nombre/email/teléfono) desde registros_de_llamada.
  let nombreLead: string | null = null;
  let emailLead: string | null = null;
  let phoneLead: string | null = null;
  if (contactId) {
    const { rows: leadRows } = await pgPool.query<{ nombre_lead: string | null; mail_lead: string | null; phone_raw_format: string | null }>(
      `SELECT nombre_lead, mail_lead, phone_raw_format FROM registros_de_llamada
       WHERE id_cuenta = $1 AND ghl_contact_id = $2 ORDER BY id_registro DESC LIMIT 1`,
      [idCuenta, contactId],
    );
    nombreLead = leadRows[0]?.nombre_lead ?? appt.title ?? null;
    emailLead = leadRows[0]?.mail_lead ?? null;
    phoneLead = leadRows[0]?.phone_raw_format ?? null;
  }

  // Si el contacto NO tiene email pero sí teléfono → crear {digitos}@gmail.com y
  // escribirlo en GHL, para que Fathom pueda anclar la reunión al contacto por email.
  if (!emailLead?.trim() && phoneLead?.trim() && contactId) {
    const digits = phoneLead.replace(/\D/g, "");
    if (digits) {
      emailLead = `${digits}@gmail.com`;
      if (token) {
        try {
          await updateContactEmail(contactId, token, emailLead);
          console.info(`[Marketplace/Appointment] contacto ${contactId} sin email → creado ${emailLead} en GHL (anchor Fathom)`);
        } catch (e) {
          console.warn(`[Marketplace/Appointment] no se pudo escribir email en GHL:`, e instanceof Error ? e.message : e);
        }
      }
    }
  }

  // Buscar la cita por su id (para actualizar la correcta y detectar reagenda).
  const { rows: existRows } = await pgPool.query<{
    id_registro_agenda: number; fecha_reunion: Date | null; categoria: string | null; fathom_recording_id: string | null;
  }>(
    `SELECT id_registro_agenda, fecha_reunion, categoria, fathom_recording_id
     FROM resumenes_diarios_agendas
     WHERE id_cuenta = $1 AND ghl_appointment_id = $2 LIMIT 1`,
    [idCuenta, apptId],
  );
  const existing = existRows[0];

  const isReagenda = !!existing && !isCancel && !!startTime && !!existing.fecha_reunion &&
    existing.fecha_reunion.getTime() !== startTime.getTime();
  const estadoCita = isDelete ? "cancelada" : mapAppointmentEstado(appt.appointmentStatus, isReagenda);

  // categoria: preservar resultado de Fathom; cancelar/no-show sí manda al dashboard.
  const fathomYaProceso = !!existing?.fathom_recording_id;
  let nuevaCategoria: string | null;
  if (isCancel) nuevaCategoria = "cancelada";
  else if (estadoCita === "no_show") nuevaCategoria = "no_show";
  else if (estadoCita === "asistida") nuevaCategoria = "asistida";
  else if (fathomYaProceso) nuevaCategoria = null;             // no pisar a Fathom
  else nuevaCategoria = existing?.categoria ?? "PDTE";         // pendiente hasta la reunión

  if (existing) {
    await pgPool.query(
      `UPDATE resumenes_diarios_agendas SET
         estado_cita    = $3,
         fecha_reunion  = COALESCE($4, fecha_reunion),
         closer         = COALESCE($5, closer),
         ghl_contact_id = COALESCE($6, ghl_contact_id),
         categoria      = COALESCE($7, categoria),
         email_lead     = COALESCE(NULLIF(email_lead, ''), $8),
         nombre_de_lead = COALESCE(nombre_de_lead, $9)
       WHERE id_registro_agenda = $1 AND id_cuenta = $2`,
      [existing.id_registro_agenda, idCuenta, estadoCita, startTime, closer, contactId, nuevaCategoria, emailLead, nombreLead],
    );
    console.info(`[Marketplace/Appointment] ${eventType} appt=${apptId} → estado_cita=${estadoCita} categoria=${nuevaCategoria ?? "(fathom)"}`);
    return;
  }

  // No existe → INSERT.
  const fechaCreada = appt.dateAdded ? new Date(appt.dateAdded) : new Date();
  await pgPool.query(
    `INSERT INTO resumenes_diarios_agendas
       (id_cuenta, ghl_contact_id, ghl_appointment_id, fecha, fecha_reunion,
        categoria, estado_cita, closer, nombre_de_lead, email_lead, origen)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ghl_appointment')`,
    [idCuenta, contactId, apptId, fechaCreada, startTime, nuevaCategoria ?? "PDTE", estadoCita, closer, nombreLead, emailLead],
  );
  console.info(`[Marketplace/Appointment] ${eventType} appt=${apptId} contacto=${contactId} → NUEVA agenda estado_cita=${estadoCita} reunion=${startTime?.toISOString?.() ?? "-"}`);
}

// ─── Audio (notas de voz) → transcripción con Whisper ────────────────────────

const AUDIO_EXT = /\.(mp3|ogg|oga|m4a|wav|aac|amr|mp4|webm|opus)(\?|$)/i;

function extractAttachmentUrls(attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return [];
  const urls: string[] = [];
  for (const a of attachments) {
    if (typeof a === "string") urls.push(a);
    else if (a && typeof a === "object") {
      const o = a as Record<string, unknown>;
      const u = o.url ?? o.fileUrl ?? o.link;
      if (typeof u === "string") urls.push(u);
    }
  }
  return urls;
}

/**
 * Si el mensaje de chat es un AUDIO (nota de voz), descarga el archivo y lo
 * transcribe con Whisper (OpenAI). Devuelve el body con el texto transcrito
 * puesto como `body` (y contentType text/plain, attachments vacío) para que
 * processChatWebhook lo procese como un mensaje de texto normal.
 * Si no es audio, devuelve el body sin cambios.
 */
async function maybeTranscribeAudioMessage(
  raw: Record<string, unknown>,
  locationId: string,
): Promise<Record<string, unknown>> {
  const contentType = String(raw.contentType ?? "").toLowerCase();
  const urls = extractAttachmentUrls(raw.attachments);
  const audioUrl =
    urls.find((u) => AUDIO_EXT.test(u)) ??
    (contentType.startsWith("audio/") ? urls[0] : undefined);
  if (!audioUrl) return raw;

  try {
    const acc = await getAccountFullByLocationId(locationId);
    const openaiKey = acc?.openai_api_key ?? null;
    const idCuenta = acc?.id_cuenta ?? null;
    const res = await fetch(audioUrl);
    if (!res.ok) throw new Error(`descarga audio HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const texto = (await transcribeAudio(buf, openaiKey, idCuenta)).trim();
    console.info(`[Marketplace/Chat] audio transcrito (${buf.length} bytes) → "${texto.slice(0, 60)}…"`);
    return { ...raw, body: `🎤 Audio transcrito:\n${texto || "(sin texto)"}`, contentType: "text/plain", attachments: [] };
  } catch (e) {
    console.warn(`[Marketplace/Chat] no se pudo transcribir audio:`, e instanceof Error ? e.message : e);
    // Igual registrar el mensaje para no perder la conversación.
    return { ...raw, body: "🎤 Audio (no se pudo transcribir)", contentType: "text/plain", attachments: [] };
  }
}

// ─── Oportunidades (OpportunityCreate/Update/StatusUpdate/Delete) ─────────────

interface GhlOpportunityPayload {
  id?: string;
  contactId?: string;
  pipelineId?: string;
  pipelineStageId?: string;
  name?: string;
  status?: string;
  monetaryValue?: number;
  dateAdded?: string;
  dateUpdated?: string;
  locationId?: string;
}
interface GhlOpportunityEvent extends GhlOpportunityPayload {
  opportunity?: GhlOpportunityPayload;
}

/**
 * Ingesta de oportunidades de GHL → tabla `oportunidades` (upsert por
 * id_cuenta + ghl_opportunity_id). Guarda contacto, pipeline, stage, status,
 * valor y fecha de creación, para poder contar "oportunidades creadas".
 */
async function handleOpportunity(eventType: string, body: GhlOpportunityEvent): Promise<void> {
  const opp = body.opportunity ?? body; // GHL manda plano o anidado bajo `opportunity`
  const locationId = body.locationId ?? opp.locationId;
  const oppId = opp.id;
  if (!locationId || !oppId) return;

  const account = await getAccountByLocationId(locationId);
  if (!account) return;
  const idCuenta = account.id_cuenta;

  const isDelete = eventType === "OpportunityDelete";
  const status = isDelete ? "deleted" : (opp.status ?? null);
  const monetary = typeof opp.monetaryValue === "number" ? opp.monetaryValue : null;
  const fechaCreada = opp.dateAdded ? new Date(opp.dateAdded) : new Date();
  const fechaActualizada = opp.dateUpdated ? new Date(opp.dateUpdated) : new Date();

  await pgPool.query(
    `INSERT INTO oportunidades
       (id_cuenta, ghl_opportunity_id, ghl_contact_id, pipeline_id, pipeline_stage_id,
        nombre, status, monetary_value, fecha_creada, fecha_actualizada)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id_cuenta, ghl_opportunity_id) DO UPDATE SET
       ghl_contact_id    = COALESCE(EXCLUDED.ghl_contact_id, oportunidades.ghl_contact_id),
       pipeline_id       = COALESCE(EXCLUDED.pipeline_id, oportunidades.pipeline_id),
       pipeline_stage_id = COALESCE(EXCLUDED.pipeline_stage_id, oportunidades.pipeline_stage_id),
       nombre            = COALESCE(EXCLUDED.nombre, oportunidades.nombre),
       status            = EXCLUDED.status,
       monetary_value    = COALESCE(EXCLUDED.monetary_value, oportunidades.monetary_value),
       fecha_actualizada = EXCLUDED.fecha_actualizada`,
    [idCuenta, oppId, opp.contactId ?? null, opp.pipelineId ?? null, opp.pipelineStageId ?? null,
     opp.name ?? null, status, monetary, fechaCreada, fechaActualizada],
  );
  console.info(`[Marketplace/Opportunity] ${eventType} opp=${oppId} contacto=${opp.contactId} status=${status}`);
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
    case "ContactUpdate":
      await handleContactUpdate(b);
      break;
    case "OutboundMessage":
    case "InboundMessage": {
      // Las llamadas llegan como mensajes CALL; el resto (Custom/SMS/WhatsApp/
      // IG/FB/etc.) son mensajes de chat → van al pipeline de chats.
      const mt = (b.messageType ?? "").toString().toUpperCase();
      if (mt === "CALL") {
        await handleCallEvent(b);
      } else if (b.locationId) {
        const raw = (body ?? {}) as Record<string, unknown>;
        // processChatWebhook deduplica por `id` (messageId); el marketplace
        // manda `messageId`, así que lo mapeamos a `id`.
        let chatRaw: Record<string, unknown> = { ...raw, id: raw.id ?? raw.messageId };
        // Si es una nota de voz → transcribir con Whisper y usar el texto.
        chatRaw = await maybeTranscribeAudioMessage(chatRaw, b.locationId);
        await processChatWebhook(chatRaw as unknown as ChatWebhookBody, b.locationId);
      }
      break;
    }
    case "AppointmentCreate":
    case "AppointmentUpdate":
    case "AppointmentDelete":
      await handleAppointment(eventType, (body ?? {}) as GhlAppointmentEvent);
      break;
    case "OpportunityCreate":
    case "OpportunityUpdate":
    case "OpportunityStatusUpdate":
    case "OpportunityDelete":
      await handleOpportunity(eventType, (body ?? {}) as GhlOpportunityEvent);
      break;
    default:
      // Otros eventos: por ahora solo shadow. Se habilitarán en fases siguientes.
      break;
  }
}

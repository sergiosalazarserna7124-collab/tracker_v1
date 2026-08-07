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
} from "../ghl-api.service.js";
import { getAccessToken } from "../oauth/ghl-oauth.service.js";
import { generateLlamadaAnalysisText, extractLlamadaObjections } from "../ai/call-analysis.service.js";

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

  // Dos etiquetas, semántica distinta:
  //  - no_trackearlead → oculto del dashboard + fuera de métricas.
  //  - descartar-lead  → fuera de métricas pero SIGUE VISIBLE (no se oculta).
  const noTrackear = hasDiscardTag(body.tags);
  const descartar = hasDescartarTag(body.tags);
  const excluido = noTrackear || descartar;          // fuera de métricas en ambos casos
  const oculto = noTrackear;                          // solo no-trackeo oculta del dashboard
  const calificacion = excluido ? "descartado" : null;

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

  // ── Identidad (nombre/email/phone) en las 3 tablas de estado actual ──
  const resLlamadas = await pgPool.query(
    `UPDATE registros_de_llamada SET
       nombre_lead      = COALESCE($3, nombre_lead),
       mail_lead        = COALESCE($4, mail_lead),
       phone_raw_format = COALESCE($5, phone_raw_format),
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
  // Una llamada FALLIDA (no conectó) NO cuenta como llamada → el lead sigue pendiente.
  if (finalizada && tipo_evento !== "fallida") {
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
    case "InboundMessage":
      // Las llamadas telefónicas llegan como mensajes de tipo CALL.
      await handleCallEvent(b);
      break;
    default:
      // Otros eventos: por ahora solo shadow. Se habilitarán en fases siguientes.
      break;
  }
}

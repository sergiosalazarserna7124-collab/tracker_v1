/**
 * AUT-317: Speed-to-lead chat alerts
 *
 * Detecta chats sin respuesta de agente y notifica via nota en GHL.
 * Extiende AUT-221 (que cubre llamadas) para el canal de chats.
 *
 * Umbrales:
 *  - 60 min  → alerta al asesor asignado (chat_stl_alerted_at)
 *  - 4 horas → escalación al manager (chat_stl_4h_alerted_at)
 *
 * Scope: solo cuentas con meta_speed_chat_min configurado + activas + pagando.
 * Ventana: últimas 48h (evita alertar backlog histórico).
 * "Sin respuesta" = ningún mensaje con role='agent' en el JSONB del chat.
 */

import { db as pgPool } from "../../config/database.js";
import { addContactNote } from "../ghl-api.service.js";

// Máximo de GHL calls totales por corrida (anti rate-limit GHL).
// 60m y 4h comparten este presupuesto global.
const MAX_CHATS_PER_RUN = 100;

interface ChatPendiente {
  id_evento: number;
  id_cuenta: number;
  nombre_lead: string | null;
  id_lead: string | null;
  asesor_asignado: string | null;
  token_ghl: string | null;
  nombre_cuenta: string | null;
  primer_msg_lead_at: Date;
  minutos_sin_respuesta: number;
}

export interface SpeedToLeadChatAlertsResult {
  alertas_60m: number;
  alertas_4h: number;
  sin_ghl_contact: number;
  sin_token_ghl: number;
  errores: number;
}

/**
 * Ejecuta el cron de speed-to-lead chat alerts.
 * Retorna estadísticas de la corrida.
 */
export async function runSpeedToLeadChatAlerts(): Promise<SpeedToLeadChatAlertsResult> {
  const result: SpeedToLeadChatAlertsResult = {
    alertas_60m: 0,
    alertas_4h: 0,
    sin_ghl_contact: 0,
    sin_token_ghl: 0,
    errores: 0,
  };

  // ── 1. Chats que necesitan alerta de 60 minutos ───────────────────────────
  // primer_msg_lead_at entre 60 min y 48h atrás, sin alerta previa, sin respuesta de agente.
  const chats60m = await pgPool.query<ChatPendiente>(
    `SELECT
       cl.id_evento,
       cl.id_cuenta,
       cl.nombre_lead,
       cl.id_lead,
       cl.asesor_asignado,
       c.token_ghl,
       c.nombre_cuenta,
       cl.primer_msg_lead_at,
       EXTRACT(EPOCH FROM (NOW() - cl.primer_msg_lead_at)) / 60 AS minutos_sin_respuesta
     FROM chats_logs cl
     JOIN cuentas c ON c.id_cuenta = cl.id_cuenta
     JOIN metas_cuenta mc ON mc.id_cuenta = cl.id_cuenta
     WHERE cl.primer_msg_lead_at IS NOT NULL
       AND cl.chat_stl_alerted_at IS NULL
       AND cl.primer_msg_lead_at >= NOW() - INTERVAL '48 hours'
       AND cl.primer_msg_lead_at < NOW() - INTERVAL '60 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(cl.chat) m
         WHERE m->>'role' = 'agent'
       )
       AND mc.meta_speed_chat_min IS NOT NULL
       AND c.estado_cuenta = 'activo'
       AND c.monto_mensualidad > 0
     ORDER BY cl.primer_msg_lead_at ASC
     LIMIT $1`,
    [MAX_CHATS_PER_RUN],
  );

  console.info(`[stl-chat] Chats para alerta 60m: ${chats60m.rows.length}`);

  for (const chat of chats60m.rows) {
    try {
      const sent = await enviarAlerta60m(chat);
      if (sent) result.alertas_60m++;
    } catch (err) {
      if ((err as Error).message?.startsWith("SIN_GHL_CONTACT")) {
        result.sin_ghl_contact++;
      } else if ((err as Error).message?.startsWith("SIN_TOKEN_GHL")) {
        result.sin_token_ghl++;
      } else if ((err as Error).message?.startsWith("GHL_TOKEN_INVALID")) {
        result.sin_token_ghl++;
      } else {
        result.errores++;
        console.error(`[stl-chat] Error alerta 60m evento=${chat.id_evento}:`, err);
      }
    }
  }

  // ── 2. Chats que necesitan escalación al manager (4 horas) ───────────────
  // Deben haber recibido alerta de 60m pero llevar >4h sin respuesta.
  const capacidad4h = MAX_CHATS_PER_RUN - chats60m.rows.length;

  if (capacidad4h <= 0) {
    console.info("[stl-chat] Presupuesto GHL agotado por alertas 60m, saltando 4h.");
  } else {
    const chats4h = await pgPool.query<ChatPendiente>(
      `SELECT
         cl.id_evento,
         cl.id_cuenta,
         cl.nombre_lead,
         cl.id_lead,
         cl.asesor_asignado,
         c.token_ghl,
         c.nombre_cuenta,
         cl.primer_msg_lead_at,
         EXTRACT(EPOCH FROM (NOW() - cl.primer_msg_lead_at)) / 60 AS minutos_sin_respuesta
       FROM chats_logs cl
       JOIN cuentas c ON c.id_cuenta = cl.id_cuenta
       JOIN metas_cuenta mc ON mc.id_cuenta = cl.id_cuenta
       WHERE cl.primer_msg_lead_at IS NOT NULL
         AND cl.chat_stl_alerted_at IS NOT NULL
         AND cl.chat_stl_4h_alerted_at IS NULL
         AND cl.primer_msg_lead_at >= NOW() - INTERVAL '48 hours'
         AND cl.primer_msg_lead_at < NOW() - INTERVAL '4 hours'
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(cl.chat) m
           WHERE m->>'role' = 'agent'
         )
         AND mc.meta_speed_chat_min IS NOT NULL
         AND c.estado_cuenta = 'activo'
         AND c.monto_mensualidad > 0
       ORDER BY cl.primer_msg_lead_at ASC
       LIMIT $1`,
      [capacidad4h],
    );

    console.info(`[stl-chat] Chats para escalación 4h: ${chats4h.rows.length}`);

    for (const chat of chats4h.rows) {
      try {
        const sent = await enviarAlerta4h(chat);
        if (sent) result.alertas_4h++;
      } catch (err) {
        if ((err as Error).message?.startsWith("SIN_GHL_CONTACT")) {
          result.sin_ghl_contact++;
        } else if ((err as Error).message?.startsWith("SIN_TOKEN_GHL")) {
          result.sin_token_ghl++;
        } else if ((err as Error).message?.startsWith("GHL_TOKEN_INVALID")) {
          result.sin_token_ghl++;
        } else {
          result.errores++;
          console.error(`[stl-chat] Error escalación 4h evento=${chat.id_evento}:`, err);
        }
      }
    }
  }

  console.info(
    `[stl-chat] Resultado: 60m=${result.alertas_60m} 4h=${result.alertas_4h} ` +
      `sin_contact=${result.sin_ghl_contact} sin_token=${result.sin_token_ghl} errores=${result.errores}`,
  );

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Envía alerta 60m al asesor asignado.
 * Retorna true si la nota se envió, false si el chat ya fue procesado
 * por otra corrida concurrente (race-condition guard via optimistic lock).
 */
async function enviarAlerta60m(chat: ChatPendiente): Promise<boolean> {
  if (!chat.id_lead) {
    throw new Error(`SIN_GHL_CONTACT: evento=${chat.id_evento}`);
  }
  if (!chat.token_ghl) {
    throw new Error(`SIN_TOKEN_GHL: cuenta=${chat.id_cuenta}`);
  }

  // Optimistic lock: marcar ANTES de llamar a GHL.
  // Si otra corrida ya marcó este chat, rowCount=0 → saltar.
  const lock = await pgPool.query(
    `UPDATE chats_logs
     SET chat_stl_alerted_at = NOW()
     WHERE id_evento = $1
       AND chat_stl_alerted_at IS NULL
     RETURNING id_evento`,
    [chat.id_evento],
  );
  if (lock.rowCount === 0) {
    console.info(`[stl-chat] 60m omitido (ya marcado): evento=${chat.id_evento}`);
    return false;
  }

  const horas = Math.floor(chat.minutos_sin_respuesta / 60);
  const mins = Math.round(chat.minutos_sin_respuesta % 60);
  const tiempoStr = horas > 0 ? `${horas}h ${mins}m` : `${mins}m`;
  const nombreLead = chat.nombre_lead ?? "Lead sin nombre";
  const asesor = chat.asesor_asignado ?? "sin asesor asignado";

  const nota =
    `⚠️ ALERTA STL CHAT: ${nombreLead} lleva ${tiempoStr} sin respuesta en chat.\n` +
    `Asesor asignado: ${asesor}\n` +
    `Por favor responder de inmediato. — AutoKPI`;

  try {
    await addContactNote(chat.id_lead, chat.token_ghl, nota);
  } catch (err) {
    const errMsg = (err as Error).message ?? "";
    // Error permanente: el contacto no existe en GHL (fue eliminado o nunca existió).
    // Mantener el lock para no reintentar indefinidamente.
    if (errMsg.includes("Contact not found") || errMsg.startsWith("GHL_CONTACT_NOT_ACCESSIBLE") || /responded 4[0-9][0-9]:/.test(errMsg)) {
      console.warn(
        `[stl-chat] Contacto inexistente en GHL, saltando evento=${chat.id_evento}: ${errMsg}`,
      );
      throw new Error(`SIN_GHL_CONTACT: evento=${chat.id_evento} contacto_inexistente`);
    }
    // Error transitorio (timeout, 5xx): revertir lock para que reintente en la próxima corrida.
    await pgPool.query(
      `UPDATE chats_logs SET chat_stl_alerted_at = NULL WHERE id_evento = $1`,
      [chat.id_evento],
    );
    throw err;
  }

  console.info(
    `[stl-chat] ✓ Alerta 60m enviada: evento=${chat.id_evento} ` +
      `cuenta=${chat.id_cuenta} lead="${nombreLead}" (${tiempoStr})`,
  );
  return true;
}

/**
 * Envía escalación 4h al manager.
 * Retorna true si la nota se envió, false si el chat ya fue procesado
 * por otra corrida concurrente (race-condition guard via optimistic lock).
 */
async function enviarAlerta4h(chat: ChatPendiente): Promise<boolean> {
  if (!chat.id_lead) {
    throw new Error(`SIN_GHL_CONTACT: evento=${chat.id_evento}`);
  }
  if (!chat.token_ghl) {
    throw new Error(`SIN_TOKEN_GHL: cuenta=${chat.id_cuenta}`);
  }

  // Optimistic lock: marcar ANTES de llamar a GHL.
  const lock = await pgPool.query(
    `UPDATE chats_logs
     SET chat_stl_4h_alerted_at = NOW()
     WHERE id_evento = $1
       AND chat_stl_4h_alerted_at IS NULL
     RETURNING id_evento`,
    [chat.id_evento],
  );
  if (lock.rowCount === 0) {
    console.info(`[stl-chat] 4h omitido (ya marcado): evento=${chat.id_evento}`);
    return false;
  }

  const horas = Math.floor(chat.minutos_sin_respuesta / 60);
  const mins = Math.round(chat.minutos_sin_respuesta % 60);
  const tiempoStr = horas > 0 ? `${horas}h ${mins}m` : `${mins}m`;
  const nombreLead = chat.nombre_lead ?? "Lead sin nombre";
  const asesor = chat.asesor_asignado ?? "sin asesor asignado";

  const nota =
    `🚨 ESCALACIÓN STL CHAT — REQUIERE ATENCIÓN DE MANAGER\n` +
    `${nombreLead} lleva ${tiempoStr} sin respuesta en chat.\n` +
    `Asesor asignado: ${asesor}\n` +
    `Este chat requiere atención inmediata del responsable de equipo. — AutoKPI`;

  try {
    await addContactNote(chat.id_lead, chat.token_ghl, nota);
  } catch (err) {
    const errMsg = (err as Error).message ?? "";
    // Error permanente: el contacto no existe en GHL.
    // Mantener el lock para no reintentar indefinidamente.
    if (errMsg.includes("Contact not found") || errMsg.startsWith("GHL_CONTACT_NOT_ACCESSIBLE") || /responded 4[0-9][0-9]:/.test(errMsg)) {
      console.warn(
        `[stl-chat] Contacto inexistente en GHL, saltando evento=${chat.id_evento}: ${errMsg}`,
      );
      throw new Error(`SIN_GHL_CONTACT: evento=${chat.id_evento} contacto_inexistente`);
    }
    // Error transitorio (timeout, 5xx): revertir lock para que reintente en la próxima corrida.
    await pgPool.query(
      `UPDATE chats_logs SET chat_stl_4h_alerted_at = NULL WHERE id_evento = $1`,
      [chat.id_evento],
    );
    throw err;
  }

  console.info(
    `[stl-chat] ✓ Escalación 4h enviada: evento=${chat.id_evento} ` +
      `cuenta=${chat.id_cuenta} lead="${nombreLead}" (${tiempoStr})`,
  );
  return true;
}

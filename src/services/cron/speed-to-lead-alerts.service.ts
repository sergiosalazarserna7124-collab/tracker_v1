/**
 * AUT-221: Speed-to-lead alerts
 *
 * Detecta leads sin primer contacto y notifica al asesor/manager via GHL nota.
 *
 * Umbrales:
 *  - 60 min  → alerta al asesor (speed_to_lead_alerted_at)
 *  - 4 horas → escalación al manager (speed_to_lead_4h_alerted_at)
 *
 * Scope: solo leads de las últimas 48h (evita alertar backlog histórico).
 * Solo cuentas activas con monto_mensualidad > 0.
 */

import { db as pgPool } from "../../config/database.js";
import { addContactNote } from "../ghl-api.service.js";
import { markTokenInvalid, savePendingNote } from "../ghl-token-guard.service.js";

// Máximo de GHL calls totales por corrida (anti rate-limit GHL).
// 60m y 4h comparten este presupuesto global: 60m consume primero,
// 4h usa el remanente. Total garantizado ≤ MAX_LEADS_PER_RUN.
const MAX_LEADS_PER_RUN = 100;

interface LeadPendiente {
  id_registro: number;
  id_cuenta: number;
  nombre_lead: string | null;
  closer_mail: string | null;
  ghl_contact_id: string | null;
  token_ghl: string | null;
  nombre_cuenta: string | null;
  fecha_evento: Date;
  minutos_sin_contacto: number;
}

export interface SpeedToLeadAlertsResult {
  alertas_60m: number;
  alertas_4h: number;
  sin_ghl_contact: number;
  sin_token_ghl: number;
  contacto_inaccesible: number;
  errores: number;
}

/**
 * Ejecuta el cron de speed-to-lead alerts.
 * Retorna estadísticas de la corrida.
 */
export async function runSpeedToLeadAlerts(): Promise<SpeedToLeadAlertsResult> {
  const result: SpeedToLeadAlertsResult = {
    alertas_60m: 0,
    alertas_4h: 0,
    sin_ghl_contact: 0,
    sin_token_ghl: 0,
    contacto_inaccesible: 0,
    errores: 0,
  };

  // Decisión de producto (2026-08): las notas de alerta speed-to-lead ya no se
  // escriben en los contactos. Se deshabilita el cron completo (reversible).
  console.info("[SpeedToLead] Alertas deshabilitadas por decisión de producto — no se escriben notas.");
  return result;

  // ── 1. Leads que necesitan alerta de 60 minutos ───────────────────────────
  // fecha_evento entre 60 min y 48h atrás, sin alerta previa
  const leads60m = await pgPool.query<LeadPendiente>(
    `SELECT
       rdl.id_registro,
       rdl.id_cuenta::integer,
       rdl.nombre_lead,
       rdl.closer_mail,
       rdl.ghl_contact_id,
       c.token_ghl,
       c.nombre_cuenta,
       rdl.fecha_evento,
       EXTRACT(EPOCH FROM (NOW() - rdl.fecha_evento)) / 60 AS minutos_sin_contacto
     FROM registros_de_llamada rdl
     JOIN cuentas c ON c.id_cuenta = rdl.id_cuenta::integer
     WHERE rdl.fecha_primera_llamada IS NULL
       AND rdl.intentos_contacto = 0
       AND rdl.speed_to_lead_alerted_at IS NULL
       AND rdl.fecha_evento >= NOW() - INTERVAL '48 hours'
       AND rdl.fecha_evento < NOW() - INTERVAL '60 minutes'
       AND c.estado_cuenta = 'activo'
       AND c.monto_mensualidad > 0
     ORDER BY rdl.fecha_evento ASC
     LIMIT $1`,
    [MAX_LEADS_PER_RUN],
  );

  console.info(`[speed-to-lead] Leads para alerta 60m: ${leads60m.rows.length}`);

  for (const lead of leads60m.rows) {
    try {
      const sent = await enviarAlerta60m(lead);
      if (sent) result.alertas_60m++;
    } catch (err) {
      if ((err as Error).message?.startsWith("SIN_GHL_CONTACT")) {
        result.sin_ghl_contact++;
      } else if ((err as Error).message?.startsWith("SIN_TOKEN_GHL")) {
        result.sin_token_ghl++;
      } else if ((err as Error).message?.startsWith("GHL_TOKEN_INVALID")) {
        result.sin_token_ghl++;
        await markTokenInvalid(lead.id_cuenta);
      } else if ((err as Error).message?.startsWith("GHL_CONTACT_NOT_ACCESSIBLE")) {
        result.contacto_inaccesible++;
        console.warn(`[speed-to-lead] Contacto inaccesible 60m registro=${lead.id_registro} cuenta=${lead.id_cuenta}: ${(err as Error).message}`);
      } else {
        result.errores++;
        console.error(`[speed-to-lead] Error alerta 60m registro=${lead.id_registro}:`, err);
      }
    }
  }

  // ── 2. Leads que necesitan escalación a manager (4 horas) ────────────────
  // Deben haber recibido alerta de 60m, pero llevar >4h sin contacto.
  // El presupuesto para 4h es el remanente del global (anti rate-limit).
  const capacidad4h = MAX_LEADS_PER_RUN - leads60m.rows.length;

  if (capacidad4h <= 0) {
    console.info("[speed-to-lead] Presupuesto GHL agotado por alertas 60m, saltando 4h.");
  } else {
    const leads4h = await pgPool.query<LeadPendiente>(
      `SELECT
         rdl.id_registro,
         rdl.id_cuenta::integer,
         rdl.nombre_lead,
         rdl.closer_mail,
         rdl.ghl_contact_id,
         c.token_ghl,
         c.nombre_cuenta,
         rdl.fecha_evento,
         EXTRACT(EPOCH FROM (NOW() - rdl.fecha_evento)) / 60 AS minutos_sin_contacto
       FROM registros_de_llamada rdl
       JOIN cuentas c ON c.id_cuenta = rdl.id_cuenta::integer
       WHERE rdl.fecha_primera_llamada IS NULL
         AND rdl.intentos_contacto = 0
         AND rdl.speed_to_lead_alerted_at IS NOT NULL
         AND rdl.speed_to_lead_4h_alerted_at IS NULL
         AND rdl.fecha_evento >= NOW() - INTERVAL '48 hours'
         AND rdl.fecha_evento < NOW() - INTERVAL '4 hours'
         AND c.estado_cuenta = 'activo'
         AND c.monto_mensualidad > 0
       ORDER BY rdl.fecha_evento ASC
       LIMIT $1`,
      [capacidad4h],
    );

    console.info(`[speed-to-lead] Leads para escalación 4h: ${leads4h.rows.length}`);

    for (const lead of leads4h.rows) {
      try {
        const sent = await enviarAlerta4h(lead);
        if (sent) result.alertas_4h++;
      } catch (err) {
        if ((err as Error).message?.startsWith("SIN_GHL_CONTACT")) {
          result.sin_ghl_contact++;
        } else if ((err as Error).message?.startsWith("SIN_TOKEN_GHL")) {
          result.sin_token_ghl++;
        } else if ((err as Error).message?.startsWith("GHL_TOKEN_INVALID")) {
          result.sin_token_ghl++;
          await markTokenInvalid(lead.id_cuenta);
        } else if ((err as Error).message?.startsWith("GHL_CONTACT_NOT_ACCESSIBLE")) {
          result.contacto_inaccesible++;
          console.warn(`[speed-to-lead] Contacto inaccesible 4h registro=${lead.id_registro} cuenta=${lead.id_cuenta}: ${(err as Error).message}`);
        } else {
          result.errores++;
          console.error(`[speed-to-lead] Error escalación 4h registro=${lead.id_registro}:`, err);
        }
      }
    }
  }

  console.info(
    `[speed-to-lead] Resultado: 60m=${result.alertas_60m} 4h=${result.alertas_4h} ` +
      `sin_contact=${result.sin_ghl_contact} sin_token=${result.sin_token_ghl} ` +
      `contacto_inaccesible=${result.contacto_inaccesible} errores=${result.errores}`,
  );

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Envía alerta 60m.
 * Retorna true si la nota se envió, false si el registro ya fue procesado
 * por otra corrida concurrente (race-condition guard via optimistic lock).
 */
async function enviarAlerta60m(lead: LeadPendiente): Promise<boolean> {
  if (!lead.ghl_contact_id) {
    throw new Error(`SIN_GHL_CONTACT: registro=${lead.id_registro}`);
  }
  if (!lead.token_ghl) {
    throw new Error(`SIN_TOKEN_GHL: cuenta=${lead.id_cuenta}`);
  }

  // Optimistic lock: marcar ANTES de llamar a GHL.
  // Si otra corrida ya marcó este registro, rowCount=0 → saltar.
  const lock = await pgPool.query(
    `UPDATE registros_de_llamada
     SET speed_to_lead_alerted_at = NOW()
     WHERE id_registro = $1
       AND speed_to_lead_alerted_at IS NULL
     RETURNING id_registro`,
    [lead.id_registro],
  );
  if (lock.rowCount === 0) {
    // Ya procesado por corrida concurrente
    console.info(`[speed-to-lead] 60m omitido (ya marcado): registro=${lead.id_registro}`);
    return false;
  }

  const horas = Math.floor(lead.minutos_sin_contacto / 60);
  const mins = Math.round(lead.minutos_sin_contacto % 60);
  const tiempoStr = horas > 0 ? `${horas}h ${mins}m` : `${mins}m`;
  const nombreLead = lead.nombre_lead ?? "Lead sin nombre";
  const asesor = lead.closer_mail ?? "sin asesor asignado";

  const nota =
    `⚠️ ALERTA SPEED-TO-LEAD: ${nombreLead} lleva ${tiempoStr} sin ser contactado.\n` +
    `Asesor asignado: ${asesor}\n` +
    `Por favor contactar de inmediato. — LeadMaster`;

  try {
    await addContactNote(lead.ghl_contact_id, lead.token_ghl, nota);
  } catch (err) {
    const isTokenInvalid = (err as Error & { isTokenInvalid?: boolean }).isTokenInvalid;
    const isPermanent =
      (err as Error).message?.startsWith("GHL_CONTACT_NOT_ACCESSIBLE") ||
      isTokenInvalid;
    if (isTokenInvalid) {
      await savePendingNote(lead.id_cuenta, lead.ghl_contact_id, nota, String(err));
    }
    if (!isPermanent) {
      await pgPool.query(
        `UPDATE registros_de_llamada SET speed_to_lead_alerted_at = NULL WHERE id_registro = $1`,
        [lead.id_registro],
      );
    }
    throw err;
  }

  console.info(
    `[speed-to-lead] ✓ Alerta 60m enviada: registro=${lead.id_registro} ` +
      `cuenta=${lead.id_cuenta} lead="${nombreLead}" (${tiempoStr})`,
  );
  return true;
}

/**
 * Envía escalación 4h.
 * Retorna true si la nota se envió, false si el registro ya fue procesado
 * por otra corrida concurrente (race-condition guard via optimistic lock).
 */
async function enviarAlerta4h(lead: LeadPendiente): Promise<boolean> {
  if (!lead.ghl_contact_id) {
    throw new Error(`SIN_GHL_CONTACT: registro=${lead.id_registro}`);
  }
  if (!lead.token_ghl) {
    throw new Error(`SIN_TOKEN_GHL: cuenta=${lead.id_cuenta}`);
  }

  // Optimistic lock: marcar ANTES de llamar a GHL.
  const lock = await pgPool.query(
    `UPDATE registros_de_llamada
     SET speed_to_lead_4h_alerted_at = NOW()
     WHERE id_registro = $1
       AND speed_to_lead_4h_alerted_at IS NULL
     RETURNING id_registro`,
    [lead.id_registro],
  );
  if (lock.rowCount === 0) {
    console.info(`[speed-to-lead] 4h omitido (ya marcado): registro=${lead.id_registro}`);
    return false;
  }

  const horas = Math.floor(lead.minutos_sin_contacto / 60);
  const mins = Math.round(lead.minutos_sin_contacto % 60);
  const tiempoStr = horas > 0 ? `${horas}h ${mins}m` : `${mins}m`;
  const nombreLead = lead.nombre_lead ?? "Lead sin nombre";
  const asesor = lead.closer_mail ?? "sin asesor asignado";

  const nota =
    `🚨 ESCALACIÓN SPEED-TO-LEAD — REQUIERE ATENCIÓN DE MANAGER\n` +
    `${nombreLead} lleva ${tiempoStr} sin ser contactado.\n` +
    `Asesor asignado: ${asesor}\n` +
    `Este lead requiere atención inmediata del responsable de equipo. — LeadMaster`;

  try {
    await addContactNote(lead.ghl_contact_id, lead.token_ghl, nota);
  } catch (err) {
    const isTokenInvalid = (err as Error & { isTokenInvalid?: boolean }).isTokenInvalid;
    const isPermanent =
      (err as Error).message?.startsWith("GHL_CONTACT_NOT_ACCESSIBLE") ||
      isTokenInvalid;
    if (isTokenInvalid) {
      await savePendingNote(lead.id_cuenta, lead.ghl_contact_id, nota, String(err));
    }
    if (!isPermanent) {
      await pgPool.query(
        `UPDATE registros_de_llamada SET speed_to_lead_4h_alerted_at = NULL WHERE id_registro = $1`,
        [lead.id_registro],
      );
    }
    throw err;
  }

  console.info(
    `[speed-to-lead] ✓ Escalación 4h enviada: registro=${lead.id_registro} ` +
      `cuenta=${lead.id_cuenta} lead="${nombreLead}" (${tiempoStr})`,
  );
  return true;
}

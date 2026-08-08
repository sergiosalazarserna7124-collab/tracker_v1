/**
 * Barrido automático de no-shows (regla de las 5 horas).
 *
 * Una cita se considera no-show cuando 5 HORAS después de la hora de la
 * reunión no ha llegado la grabación de Fathom. Antes de marcarla, se
 * verifica la cita en GHL por si fue REPROGRAMADA (startTime futuro →
 * se actualiza fecha_reunion y sigue pendiente) o CANCELADA (→ cancelada).
 * Solo si de verdad no ocurrió: categoria='no_show' + etiqueta GHL
 * "no_show" en el contacto (para que las automatizaciones del cliente
 * puedan reaccionar).
 *
 * Si Fathom llega tarde (puede tardar 24-72h), el webhook de asistencia
 * reclasifica el no_show a asistida — el marcado es autocorregible.
 *
 * Corre cada NO_SHOWS_SWEEP_MIN minutos (default 30) desde el propio
 * backend; el histórico updateNoShows (/cron/update-no-shows) queda para
 * disparos manuales.
 */

import { db as pgPool } from "../../config/database.js";
import { getAccessToken } from "../oauth/ghl-oauth.service.js";
import { safeAddContactTag } from "../ghl-api.service.js";

const HORAS_ESPERA_FATHOM = 5;
const TAG_NO_SHOW = "no_show_lm";
const TAG_INTERNO = "no_show_lm";

interface CitaPendiente {
  id_registro_agenda: number;
  id_cuenta: number;
  ghl_contact_id: string | null;
  ghl_appointment_id: string | null;
  fecha_reunion: Date;
  locationid: string | null;
  token_ghl: string | null;
}

interface GhlAppointment {
  appointmentStatus?: string;
  appoinmentStatus?: string; // typo real de la API de GHL
  startTime?: string;
}

export interface NoShowsSweepResult {
  revisadas: number;
  no_shows: number;
  reagendadas: number;
  canceladas: number;
  errores: string[];
}

async function getGhlAppointment(apptId: string, token: string): Promise<{ status: number; appt: GhlAppointment | null }> {
  const res = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${apptId}`, {
    headers: { Authorization: `Bearer ${token}`, Version: "2021-04-15", Accept: "application/json" },
  });
  if (!res.ok) return { status: res.status, appt: null };
  const data = (await res.json()) as { appointment?: GhlAppointment };
  return { status: res.status, appt: data.appointment ?? null };
}

export async function runNoShowsSweep(): Promise<NoShowsSweepResult> {
  const result: NoShowsSweepResult = { revisadas: 0, no_shows: 0, reagendadas: 0, canceladas: 0, errores: [] };

  // Citas PDTE cuya reunión fue hace ≥5h y sin grabación de Fathom.
  const { rows } = await pgPool.query<CitaPendiente>(
    `SELECT a.id_registro_agenda, a.id_cuenta, a.ghl_contact_id, a.ghl_appointment_id,
            a.fecha_reunion, c.locationid, c.token_ghl
     FROM resumenes_diarios_agendas a
     JOIN cuentas c ON c.id_cuenta = a.id_cuenta
     WHERE a.categoria = 'PDTE'
       AND a.fecha_reunion IS NOT NULL
       AND a.fecha_reunion <= NOW() - INTERVAL '${HORAS_ESPERA_FATHOM} hours'
       AND a.fathom_recording_id IS NULL
     ORDER BY a.fecha_reunion ASC
     LIMIT 100`,
  );

  for (const cita of rows) {
    result.revisadas += 1;
    try {
      let token: string | null = null;
      if (cita.locationid) token = await getAccessToken(cita.locationid).catch(() => null);
      if (!token) token = cita.token_ghl;

      // Verificación en GHL: ¿la cita fue reprogramada o cancelada?
      if (token && cita.ghl_appointment_id) {
        const { status, appt } = await getGhlAppointment(cita.ghl_appointment_id, token);

        if (appt) {
          const estado = (appt.appointmentStatus ?? appt.appoinmentStatus ?? "").toLowerCase();
          const inicio = appt.startTime ? new Date(appt.startTime) : null;

          if (estado === "cancelled" || estado === "canceled") {
            await pgPool.query(
              `UPDATE resumenes_diarios_agendas SET categoria = 'cancelada', estado_cita = 'cancelada' WHERE id_registro_agenda = $1`,
              [cita.id_registro_agenda],
            );
            result.canceladas += 1;
            console.info(`[NoShowsAuto] cita ${cita.id_registro_agenda} estaba CANCELADA en GHL → cancelada`);
            continue;
          }
          if (inicio && inicio.getTime() > Date.now()) {
            // Reprogramada hacia el futuro → actualizar fecha y seguir esperando
            await pgPool.query(
              `UPDATE resumenes_diarios_agendas SET fecha_reunion = $2, estado_cita = 'reagendada' WHERE id_registro_agenda = $1`,
              [cita.id_registro_agenda, inicio],
            );
            result.reagendadas += 1;
            console.info(`[NoShowsAuto] cita ${cita.id_registro_agenda} REPROGRAMADA en GHL → nueva fecha ${inicio.toISOString()}`);
            continue;
          }
          if (estado === "showed") {
            // Alguien la marcó como asistida en GHL → dejarla para Fathom/asistencia manual
            console.info(`[NoShowsAuto] cita ${cita.id_registro_agenda} marcada 'showed' en GHL → no se toca`);
            continue;
          }
          // Reprogramada hacia otra hora YA pasada: cae al no_show normal.
        } else if (status === 404) {
          // La cita fue BORRADA en GHL → tratar como cancelada
          await pgPool.query(
            `UPDATE resumenes_diarios_agendas SET categoria = 'cancelada', estado_cita = 'cancelada' WHERE id_registro_agenda = $1`,
            [cita.id_registro_agenda],
          );
          result.canceladas += 1;
          console.info(`[NoShowsAuto] cita ${cita.id_registro_agenda} borrada en GHL (404) → cancelada`);
          continue;
        }
        // Otros errores HTTP: seguimos con la información local (la cita pasó hace ≥5h).
      }

      // No ocurrió, no se canceló, no se movió → NO SHOW
      await pgPool.query(
        `UPDATE resumenes_diarios_agendas SET
           categoria = 'no_show',
           tags = CASE WHEN tags IS NULL OR tags = '' THEN '${TAG_INTERNO}' ELSE tags || ',${TAG_INTERNO}' END
         WHERE id_registro_agenda = $1`,
        [cita.id_registro_agenda],
      );
      result.no_shows += 1;
      console.info(`[NoShowsAuto] cita ${cita.id_registro_agenda} (reunión ${cita.fecha_reunion.toISOString()}) → no_show`);

      // Etiqueta "no_show" en el contacto de GHL (dispara automatizaciones del cliente)
      if (token && cita.ghl_contact_id) {
        try {
          await safeAddContactTag(cita.ghl_contact_id, token, TAG_NO_SHOW, cita.locationid);
        } catch (e) {
          console.warn(`[NoShowsAuto] no se pudo etiquetar contacto ${cita.ghl_contact_id}:`, e instanceof Error ? e.message : e);
        }
      }
    } catch (e) {
      result.errores.push(`cita ${cita.id_registro_agenda}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (result.revisadas > 0) {
    console.info(
      `[NoShowsAuto] barrido: revisadas=${result.revisadas} no_shows=${result.no_shows} ` +
      `reagendadas=${result.reagendadas} canceladas=${result.canceladas} errores=${result.errores.length}`,
    );
  }
  return result;
}

// ─── Loop interno ─────────────────────────────────────────────────────────────

let running = false;

export function startNoShowsLoop(intervalMinutes: number): NodeJS.Timeout | null {
  if (!intervalMinutes || intervalMinutes <= 0) return null;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runNoShowsSweep()
      .catch((e) => console.error("[NoShowsAuto] barrido falló:", e instanceof Error ? e.message : e))
      .finally(() => { running = false; });
  }, intervalMinutes * 60_000);
  timer.unref();
  console.info(`[NoShowsAuto] loop interno activo cada ${intervalMinutes} min (regla: ${HORAS_ESPERA_FATHOM}h sin Fathom → no_show)`);
  return timer;
}

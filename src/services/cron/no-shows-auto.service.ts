/**
 * Barrido automático de no-shows.
 *
 * El endpoint /cron/daily-tasks (updateNoShows) existía pero dependía de un
 * scheduler externo que nunca se configuró — jamás corrió (0 tags
 * 'noshowautoia' en toda la BD). Este loop interno lo automatiza:
 *
 * Cada hora, agrupa las cuentas por su "ayer" en la zona horaria de cada una
 * y ejecuta updateNoShows para ese día (y el anterior, por resiliencia ante
 * caídas). Efecto: una cita PDTE cuya reunión fue AYER (hora local de la
 * cuenta) se marca no_show en la primera hora tras la medianoche local —
 * salvo que tenga grabación de Fathom. Si Fathom llega después (puede tardar
 * 24-72h), el webhook de asistencia la reclasifica.
 */

import { db as pgPool } from "../../config/database.js";
import { updateNoShows } from "./daily-tasks.service.js";

const TZ_DEFAULT = "America/Mexico_City";

function ayerEnTz(tz: string): string {
  let hoy: string;
  try {
    hoy = new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  } catch {
    hoy = new Date().toLocaleDateString("en-CA", { timeZone: TZ_DEFAULT });
  }
  return new Date(new Date(`${hoy}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
}

function diaAnterior(fecha: string): string {
  return new Date(new Date(`${fecha}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
}

export interface NoShowsSweepResult {
  grupos: number;
  marcados: number;
  errores: string[];
}

export async function runNoShowsSweep(): Promise<NoShowsSweepResult> {
  const { rows } = await pgPool.query<{ id_cuenta: number; zona_horaria_iana: string | null }>(
    `SELECT id_cuenta, zona_horaria_iana FROM cuentas
     WHERE COALESCE(LOWER(estado_cuenta), 'activo') NOT IN ('inactivo', 'inactiva', 'suspendido', 'suspendida')`,
  );

  // Agrupar cuentas por su "ayer" local (distintas zonas → distintos días)
  const grupos = new Map<string, number[]>();
  for (const c of rows) {
    const ayer = ayerEnTz(c.zona_horaria_iana || TZ_DEFAULT);
    const ids = grupos.get(ayer) ?? [];
    ids.push(c.id_cuenta);
    grupos.set(ayer, ids);
  }

  const result: NoShowsSweepResult = { grupos: grupos.size, marcados: 0, errores: [] };
  for (const [ayer, ids] of grupos) {
    // Ayer + antier: si el proceso estuvo caído un día, el siguiente barrido recupera.
    for (const target of [ayer, diaAnterior(ayer)]) {
      try {
        const res = await updateNoShows({ target_date: target, account_ids: ids });
        result.marcados += res.processed_count ?? 0;
      } catch (e) {
        result.errores.push(`${target}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (result.marcados > 0 || result.errores.length > 0) {
    console.info(`[NoShowsAuto] barrido: grupos=${result.grupos} marcados=${result.marcados} errores=${result.errores.length}`);
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
  console.info(`[NoShowsAuto] loop interno activo cada ${intervalMinutes} min`);
  return timer;
}

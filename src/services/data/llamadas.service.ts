import { db } from "../../config/database.js";
import { drizzleDb } from "../../config/drizzle.js";
import { cuentas } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import {
  esCalificado,
  parseCriteriosCalificacion,
  type CriteriosCalificacion,
} from "./criterios-calificacion.utils.js";

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface LlamadaRow {
  id: number;
  id_cuenta: number;
  ts: string | null;
  tipo_evento: string | null;
  estado_resultado: string | null;
  nombre_lead: string | null;
  closer_mail: string | null;
  nombre_closer: string | null;
  phone: string | null;
  tags_internos: unknown;
  speed_to_lead: number | null;
  es_calificado: boolean;
  calificacion_manual: string | null;
}

// ─── Servicio principal ───────────────────────────────────────────────────────

export interface GetLlamadasParams {
  idCuenta: number;
  desde?: string;
  hasta?: string;
}

export interface GetLlamadasResult {
  llamadas: LlamadaRow[];
  total: number;
}

export async function getLlamadasData(params: GetLlamadasParams): Promise<GetLlamadasResult> {
  const { idCuenta, desde, hasta } = params;

  const [cuenta] = await drizzleDb
    .select({
      criterios_calificacion: cuentas.criterios_calificacion,
    })
    .from(cuentas)
    .where(eq(cuentas.id_cuenta, idCuenta))
    .limit(1);

  let criterios: CriteriosCalificacion | null = null;
  if (cuenta?.criterios_calificacion !== null && cuenta?.criterios_calificacion !== undefined) {
    try {
      criterios = parseCriteriosCalificacion(cuenta.criterios_calificacion);
    } catch {
      criterios = null;
    }
  }

  const conditions: string[] = ["id_cuenta = $1"];
  const values: unknown[] = [idCuenta];

  if (desde) {
    values.push(desde);
    conditions.push(`ts >= $${values.length}::date`);
  }
  if (hasta) {
    values.push(hasta);
    conditions.push(`ts < ($${values.length}::date + INTERVAL '1 day')`);
  }

  const where = conditions.join(" AND ");

  interface LlamadaRowRaw extends Omit<LlamadaRow, "es_calificado"> {}

  const { rows: rawRows } = await db.query<LlamadaRowRaw>(
    `SELECT
       id, id_cuenta, ts, tipo_evento, estado_resultado,
       nombre_lead, closer_mail, nombre_closer, phone,
       tags_internos, speed_to_lead, calificacion_manual
     FROM log_llamadas
     WHERE ${where}
     ORDER BY ts DESC`,
    values,
  );

  const rows: LlamadaRow[] = rawRows.map((r) => ({
    ...r,
    calificacion_manual: r.calificacion_manual ?? null,
    es_calificado: esCalificado(r.estado_resultado, criterios, "llamadas", r.calificacion_manual),
  }));

  return { llamadas: rows, total: rows.length };
}

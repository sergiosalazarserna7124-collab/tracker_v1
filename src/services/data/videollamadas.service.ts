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

interface VideollamadaRow {
  id_registro_agenda: number;
  id_cuenta: number;
  fecha: string | null;
  fecha_reunion: string | null;
  nombre_de_lead: string | null;
  categoria: string | null;
  closer: string | null;
  link_llamada: string | null;
  fathom_share_url: string | null;
  tags_internos: unknown;
  es_calificado: boolean;
}

// ─── Servicio principal ───────────────────────────────────────────────────────

export interface GetVideollamadasParams {
  idCuenta: number;
  desde?: string;
  hasta?: string;
}

export interface GetVideollamadasResult {
  videollamadas: VideollamadaRow[];
  total: number;
}

export async function getVideollamadasData(params: GetVideollamadasParams): Promise<GetVideollamadasResult> {
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
    conditions.push(`fecha >= $${values.length}::date`);
  }
  if (hasta) {
    values.push(hasta);
    conditions.push(`fecha < ($${values.length}::date + INTERVAL '1 day')`);
  }

  const where = conditions.join(" AND ");

  interface VideollamadaRowRaw extends Omit<VideollamadaRow, "es_calificado"> {}

  const { rows: rawRows } = await db.query<VideollamadaRowRaw>(
    `SELECT
       id_registro_agenda, id_cuenta, fecha, fecha_reunion,
       nombre_de_lead, categoria, closer,
       link_llamada, fathom_share_url, tags_internos
     FROM resumenes_diarios_agendas
     WHERE ${where}
     ORDER BY fecha DESC`,
    values,
  );

  const rows: VideollamadaRow[] = rawRows.map((r) => ({
    ...r,
    es_calificado: esCalificado(r.categoria, criterios, "videollamadas"),
  }));

  return { videollamadas: rows, total: rows.length };
}

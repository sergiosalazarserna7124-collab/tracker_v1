import { db } from "../../config/database.js";

export interface MapaTiemposParams {
  idCuenta: number;
  desde?: string;
  hasta?: string;
  asesor?: string;
  lead?: string;
}

interface LeadTimeline {
  id_registro: number;
  nombre_lead: string | null;
  asesor: string;
  t_llegada: string;
  t_llamada: string | null;
  t_agenda: string | null;
  t1_seconds: number | null;
  t2_seconds: number | null;
}

interface AsesorStats {
  asesor: string;
  t1_mediana_seconds: number | null;
  t1_p90_seconds: number | null;
  t1_n: number;
  t2_mediana_seconds: number | null;
  t2_p90_seconds: number | null;
  t2_n: number;
}

export interface MapaTiemposResult {
  asesores: AsesorStats[];
  lead_timeline: LeadTimeline | null;
  total_leads: number;
}

export async function getMapaTiempos(
  params: MapaTiemposParams,
): Promise<MapaTiemposResult> {
  const { idCuenta, desde, hasta, asesor, lead } = params;

  const tzRow = await db.query(
    `SELECT zona_horaria_iana FROM cuentas WHERE id_cuenta = $1`,
    [idCuenta],
  );
  const tz = (tzRow.rows[0]?.zona_horaria_iana as string) ?? "UTC";

  if (lead) {
    return getSingleLeadTimeline(idCuenta, Number(lead), tz);
  }

  return getAsesorStats(idCuenta, desde, hasta, asesor, tz);
}

async function getSingleLeadTimeline(
  idCuenta: number,
  idRegistro: number,
  tz: string,
): Promise<MapaTiemposResult> {
  const sql = `
    WITH lead AS (
      SELECT
        r.id_registro,
        r.nombre_lead,
        COALESCE(r.nombre_closer, r.closer_mail, 'Sin asesor') AS asesor,
        r.fecha_evento AS t_llegada,
        r.ghl_contact_id,
        r.mail_lead
      FROM registros_de_llamada r
      WHERE r.id_cuenta = $1::text
        AND r.id_registro = $2
        AND r.excluido_metricas = false
    ),
    first_call AS (
      SELECT MIN(l.ts) AS t_llamada
      FROM log_llamadas l
      WHERE l.id_registro = $2
        AND l.id_cuenta = $1::int
    ),
    first_agenda AS (
      SELECT MIN(w.received_at) AS t_agenda
      FROM webhook_events_log w
      JOIN lead ld ON true
      WHERE w.fuente = 'ghl_agenda'
        AND w.id_cuenta = $1::int
        AND (
          (ld.ghl_contact_id IS NOT NULL AND ld.ghl_contact_id != ''
           AND w.payload_raw->>'contact_id' = ld.ghl_contact_id)
          OR
          (ld.mail_lead IS NOT NULL AND ld.mail_lead != ''
           AND w.payload_raw->>'email' = ld.mail_lead)
        )
    )
    SELECT
      ld.id_registro,
      ld.nombre_lead,
      ld.asesor,
      ld.t_llegada,
      fc.t_llamada,
      fa.t_agenda,
      EXTRACT(EPOCH FROM (fc.t_llamada - ld.t_llegada)) AS t1_seconds,
      EXTRACT(EPOCH FROM (fa.t_agenda - fc.t_llamada)) AS t2_seconds
    FROM lead ld
    CROSS JOIN first_call fc
    CROSS JOIN first_agenda fa
  `;

  const result = await db.query(sql, [idCuenta, idRegistro]);
  const row = result.rows[0];

  if (!row) {
    return { asesores: [], lead_timeline: null, total_leads: 0 };
  }

  return {
    asesores: [],
    lead_timeline: {
      id_registro: row.id_registro,
      nombre_lead: row.nombre_lead,
      asesor: row.asesor,
      t_llegada: row.t_llegada,
      t_llamada: row.t_llamada,
      t_agenda: row.t_agenda,
      t1_seconds: row.t1_seconds != null ? Number(row.t1_seconds) : null,
      t2_seconds: row.t2_seconds != null ? Number(row.t2_seconds) : null,
    },
    total_leads: 1,
  };
}

async function getAsesorStats(
  idCuenta: number,
  desde: string | undefined,
  hasta: string | undefined,
  asesor: string | undefined,
  tz: string,
): Promise<MapaTiemposResult> {
  const values: unknown[] = [idCuenta];
  let paramIdx = 2;

  let dateFilter = "";
  if (desde) {
    dateFilter += ` AND r.fecha_evento >= (($${paramIdx}::date)::text || ' 00:00:00')::timestamp AT TIME ZONE $${paramIdx + 1}`;
    values.push(desde, tz);
    paramIdx += 2;
  }
  if (hasta) {
    dateFilter += ` AND r.fecha_evento < ((($${paramIdx}::date + 1))::text || ' 00:00:00')::timestamp AT TIME ZONE $${paramIdx + 1}`;
    values.push(hasta, tz);
    paramIdx += 2;
  }

  let asesorFilter = "";
  if (asesor) {
    asesorFilter = ` AND (r.nombre_closer = $${paramIdx} OR r.closer_mail = $${paramIdx})`;
    values.push(asesor);
    paramIdx++;
  }

  const sql = `
    WITH leads AS (
      SELECT
        r.id_registro,
        r.ghl_contact_id,
        r.mail_lead,
        r.fecha_evento AS t_llegada,
        COALESCE(r.nombre_closer, r.closer_mail, 'Sin asesor') AS asesor
      FROM registros_de_llamada r
      WHERE r.id_cuenta = $1::text
        AND r.excluido_metricas = false
        AND r.fecha_evento IS NOT NULL
        ${dateFilter}
        ${asesorFilter}
    ),
    first_calls AS (
      SELECT l.id_registro, MIN(l.ts) AS t_llamada
      FROM log_llamadas l
      WHERE l.id_cuenta = $1::int
      GROUP BY l.id_registro
    ),
    first_agendas AS (
      SELECT
        ld.id_registro,
        MIN(w.received_at) AS t_agenda
      FROM leads ld
      JOIN webhook_events_log w
        ON w.fuente = 'ghl_agenda'
        AND w.id_cuenta = $1::int
        AND (
          (ld.ghl_contact_id IS NOT NULL AND ld.ghl_contact_id != ''
           AND w.payload_raw->>'contact_id' = ld.ghl_contact_id)
          OR
          (ld.mail_lead IS NOT NULL AND ld.mail_lead != ''
           AND w.payload_raw->>'email' = ld.mail_lead)
        )
      GROUP BY ld.id_registro
    ),
    deltas AS (
      SELECT
        ld.asesor,
        EXTRACT(EPOCH FROM (fc.t_llamada - ld.t_llegada)) AS t1,
        EXTRACT(EPOCH FROM (fa.t_agenda - fc.t_llamada)) AS t2
      FROM leads ld
      LEFT JOIN first_calls fc ON fc.id_registro = ld.id_registro
      LEFT JOIN first_agendas fa ON fa.id_registro = ld.id_registro
    )
    SELECT
      d.asesor,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY d.t1) FILTER (WHERE d.t1 IS NOT NULL AND d.t1 >= 0) AS t1_mediana,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY d.t1) FILTER (WHERE d.t1 IS NOT NULL AND d.t1 >= 0) AS t1_p90,
      COUNT(*) FILTER (WHERE d.t1 IS NOT NULL AND d.t1 >= 0) AS t1_n,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY d.t2) FILTER (WHERE d.t2 IS NOT NULL AND d.t2 >= 0) AS t2_mediana,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY d.t2) FILTER (WHERE d.t2 IS NOT NULL AND d.t2 >= 0) AS t2_p90,
      COUNT(*) FILTER (WHERE d.t2 IS NOT NULL AND d.t2 >= 0) AS t2_n
    FROM deltas d
    GROUP BY d.asesor
    ORDER BY d.asesor
  `;

  const result = await db.query(sql, values);

  const totalRow = await db.query(
    `SELECT COUNT(*)::int AS total
     FROM registros_de_llamada r
     WHERE r.id_cuenta = $1::text
       AND r.excluido_metricas = false
       AND r.fecha_evento IS NOT NULL
       ${dateFilter}
       ${asesorFilter}`,
    values,
  );

  const asesores: AsesorStats[] = result.rows.map((r: Record<string, unknown>) => ({
    asesor: r.asesor as string,
    t1_mediana_seconds: r.t1_mediana != null ? Number(r.t1_mediana) : null,
    t1_p90_seconds: r.t1_p90 != null ? Number(r.t1_p90) : null,
    t1_n: Number(r.t1_n),
    t2_mediana_seconds: r.t2_mediana != null ? Number(r.t2_mediana) : null,
    t2_p90_seconds: r.t2_p90 != null ? Number(r.t2_p90) : null,
    t2_n: Number(r.t2_n),
  }));

  return {
    asesores,
    lead_timeline: null,
    total_leads: Number(totalRow.rows[0]?.total ?? 0),
  };
}

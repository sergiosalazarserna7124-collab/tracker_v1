import { db } from "../../config/database.js";

export interface MapaTiemposParams {
  idCuenta: number;
  desde?: string;
  hasta?: string;
  asesor?: string;
  lead?: string;
  closerEmails?: string[];
}

interface LeadTimeline {
  id_registro: number;
  nombre_lead: string | null;
  asesor: string;
  t_llegada: string;
  t_llamada: string | null;
  t_agenda: string | null;
  t_asista: string | null;
  t1_seconds: number | null;
  t2_seconds: number | null;
  t3_seconds: number | null;
}

interface AsesorStats {
  asesor: string;
  t1_mediana_seconds: number | null;
  t1_p90_seconds: number | null;
  t1_n: number;
  t2_mediana_seconds: number | null;
  t2_p90_seconds: number | null;
  t2_n: number;
  t3_mediana_seconds: number | null;
  t3_p90_seconds: number | null;
  t3_n: number;
}

interface StuckCounts {
  sin_llamar: number;
  sin_agendar: number;
  sin_asistir: number;
}

export interface MapaTiemposResult {
  asesores: AsesorStats[];
  lead_timeline: LeadTimeline | null;
  total_leads: number;
  stuck: StuckCounts;
}

export async function getMapaTiempos(
  params: MapaTiemposParams,
): Promise<MapaTiemposResult> {
  const { idCuenta, desde, hasta, asesor, lead, closerEmails } = params;
  const activeCloserEmails = closerEmails?.length ? closerEmails : undefined;

  const tzRow = await db.query(
    `SELECT zona_horaria_iana FROM cuentas WHERE id_cuenta = $1`,
    [idCuenta],
  );
  const tz = (tzRow.rows[0]?.zona_horaria_iana as string) ?? "UTC";

  if (lead) {
    return getSingleLeadTimeline(idCuenta, Number(lead), tz, activeCloserEmails);
  }

  return getAsesorStats(idCuenta, desde, hasta, asesor, tz, activeCloserEmails);
}

async function getSingleLeadTimeline(
  idCuenta: number,
  idRegistro: number,
  tz: string,
  closerEmails?: string[],
): Promise<MapaTiemposResult> {
  const values: unknown[] = [idCuenta, idRegistro];
  let closerFilter = "";
  if (closerEmails) {
    closerFilter = ` AND (r.closer_mail = ANY($3) OR r.nombre_closer = ANY($3))`;
    values.push(closerEmails);
  }

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
        ${closerFilter}
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
    ),
    first_asista AS (
      SELECT MIN(a.fecha_reunion) AS t_asista
      FROM resumenes_diarios_agendas a
      JOIN lead ld ON true
      WHERE a.id_cuenta = $1::int
        AND LOWER(a.categoria) NOT IN ('pdte', 'no_show', 'cancelada')
        AND a.fecha_reunion IS NOT NULL
        AND (
          (ld.ghl_contact_id IS NOT NULL AND ld.ghl_contact_id != ''
           AND a.ghl_contact_id = ld.ghl_contact_id)
          OR
          (ld.mail_lead IS NOT NULL AND ld.mail_lead != ''
           AND LOWER(a.email_lead) = LOWER(ld.mail_lead))
        )
    )
    SELECT
      ld.id_registro,
      ld.nombre_lead,
      ld.asesor,
      ld.t_llegada,
      fc.t_llamada,
      fa.t_agenda,
      fs.t_asista,
      EXTRACT(EPOCH FROM (fc.t_llamada - ld.t_llegada)) AS t1_seconds,
      EXTRACT(EPOCH FROM (fa.t_agenda - fc.t_llamada)) AS t2_seconds,
      EXTRACT(EPOCH FROM (fs.t_asista - fa.t_agenda)) AS t3_seconds
    FROM lead ld
    CROSS JOIN first_call fc
    CROSS JOIN first_agenda fa
    CROSS JOIN first_asista fs
  `;

  const result = await db.query(sql, values);
  const row = result.rows[0];

  if (!row) {
    return { asesores: [], lead_timeline: null, total_leads: 0, stuck: { sin_llamar: 0, sin_agendar: 0, sin_asistir: 0 } };
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
      t_asista: row.t_asista,
      t1_seconds: row.t1_seconds != null ? Number(row.t1_seconds) : null,
      t2_seconds: row.t2_seconds != null ? Number(row.t2_seconds) : null,
      t3_seconds: row.t3_seconds != null ? Number(row.t3_seconds) : null,
    },
    total_leads: 1,
    stuck: { sin_llamar: 0, sin_agendar: 0, sin_asistir: 0 },
  };
}

async function getAsesorStats(
  idCuenta: number,
  desde: string | undefined,
  hasta: string | undefined,
  asesor: string | undefined,
  tz: string,
  closerEmails?: string[],
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

  let closerEmailsFilter = "";
  if (closerEmails) {
    closerEmailsFilter = ` AND (r.closer_mail = ANY($${paramIdx}) OR r.nombre_closer = ANY($${paramIdx}))`;
    values.push(closerEmails);
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
        ${closerEmailsFilter}
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
    first_asistencias AS (
      SELECT
        ld.id_registro,
        MIN(a.fecha_reunion) AS t_asista
      FROM leads ld
      JOIN resumenes_diarios_agendas a
        ON a.id_cuenta = $1::int
        AND LOWER(a.categoria) NOT IN ('pdte', 'no_show', 'cancelada')
        AND a.fecha_reunion IS NOT NULL
        AND (
          (ld.ghl_contact_id IS NOT NULL AND ld.ghl_contact_id != ''
           AND a.ghl_contact_id = ld.ghl_contact_id)
          OR
          (ld.mail_lead IS NOT NULL AND ld.mail_lead != ''
           AND LOWER(a.email_lead) = LOWER(ld.mail_lead))
        )
      GROUP BY ld.id_registro
    ),
    deltas AS (
      SELECT
        ld.asesor,
        EXTRACT(EPOCH FROM (fc.t_llamada - ld.t_llegada)) AS t1,
        EXTRACT(EPOCH FROM (fa.t_agenda - fc.t_llamada)) AS t2,
        EXTRACT(EPOCH FROM (fs.t_asista - fa.t_agenda)) AS t3,
        fc.t_llamada,
        fa.t_agenda,
        fs.t_asista
      FROM leads ld
      LEFT JOIN first_calls fc ON fc.id_registro = ld.id_registro
      LEFT JOIN first_agendas fa ON fa.id_registro = ld.id_registro
      LEFT JOIN first_asistencias fs ON fs.id_registro = ld.id_registro
    )
    SELECT
      d.asesor,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY d.t1) FILTER (WHERE d.t1 IS NOT NULL AND d.t1 >= 0) AS t1_mediana,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY d.t1) FILTER (WHERE d.t1 IS NOT NULL AND d.t1 >= 0) AS t1_p90,
      COUNT(*) FILTER (WHERE d.t1 IS NOT NULL AND d.t1 >= 0) AS t1_n,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY d.t2) FILTER (WHERE d.t2 IS NOT NULL AND d.t2 >= 0) AS t2_mediana,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY d.t2) FILTER (WHERE d.t2 IS NOT NULL AND d.t2 >= 0) AS t2_p90,
      COUNT(*) FILTER (WHERE d.t2 IS NOT NULL AND d.t2 >= 0) AS t2_n,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY d.t3) FILTER (WHERE d.t3 IS NOT NULL AND d.t3 >= 0) AS t3_mediana,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY d.t3) FILTER (WHERE d.t3 IS NOT NULL AND d.t3 >= 0) AS t3_p90,
      COUNT(*) FILTER (WHERE d.t3 IS NOT NULL AND d.t3 >= 0) AS t3_n
    FROM deltas d
    GROUP BY d.asesor
    ORDER BY d.asesor
  `;

  const result = await db.query(sql, values);

  const stuckSql = `
    WITH leads AS (
      SELECT
        r.id_registro,
        r.ghl_contact_id,
        r.mail_lead
      FROM registros_de_llamada r
      WHERE r.id_cuenta = $1::text
        AND r.excluido_metricas = false
        AND r.fecha_evento IS NOT NULL
        ${dateFilter}
        ${asesorFilter}
        ${closerEmailsFilter}
    ),
    first_calls AS (
      SELECT l.id_registro, MIN(l.ts) AS t_llamada
      FROM log_llamadas l
      WHERE l.id_cuenta = $1::int
      GROUP BY l.id_registro
    ),
    first_agendas AS (
      SELECT ld.id_registro, MIN(w.received_at) AS t_agenda
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
    first_asistencias AS (
      SELECT ld.id_registro, MIN(a.fecha_reunion) AS t_asista
      FROM leads ld
      JOIN resumenes_diarios_agendas a
        ON a.id_cuenta = $1::int
        AND LOWER(a.categoria) NOT IN ('pdte', 'no_show', 'cancelada')
        AND a.fecha_reunion IS NOT NULL
        AND (
          (ld.ghl_contact_id IS NOT NULL AND ld.ghl_contact_id != ''
           AND a.ghl_contact_id = ld.ghl_contact_id)
          OR
          (ld.mail_lead IS NOT NULL AND ld.mail_lead != ''
           AND LOWER(a.email_lead) = LOWER(ld.mail_lead))
        )
      GROUP BY ld.id_registro
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE fc.t_llamada IS NULL)::int AS sin_llamar,
      COUNT(*) FILTER (WHERE fc.t_llamada IS NOT NULL AND fa.t_agenda IS NULL)::int AS sin_agendar,
      COUNT(*) FILTER (WHERE fa.t_agenda IS NOT NULL AND fs.t_asista IS NULL)::int AS sin_asistir
    FROM leads ld
    LEFT JOIN first_calls fc ON fc.id_registro = ld.id_registro
    LEFT JOIN first_agendas fa ON fa.id_registro = ld.id_registro
    LEFT JOIN first_asistencias fs ON fs.id_registro = ld.id_registro
  `;

  const stuckResult = await db.query(stuckSql, values);
  const stuckRow = stuckResult.rows[0];

  const asesores: AsesorStats[] = result.rows.map((r: Record<string, unknown>) => ({
    asesor: r.asesor as string,
    t1_mediana_seconds: r.t1_mediana != null ? Number(r.t1_mediana) : null,
    t1_p90_seconds: r.t1_p90 != null ? Number(r.t1_p90) : null,
    t1_n: Number(r.t1_n),
    t2_mediana_seconds: r.t2_mediana != null ? Number(r.t2_mediana) : null,
    t2_p90_seconds: r.t2_p90 != null ? Number(r.t2_p90) : null,
    t2_n: Number(r.t2_n),
    t3_mediana_seconds: r.t3_mediana != null ? Number(r.t3_mediana) : null,
    t3_p90_seconds: r.t3_p90 != null ? Number(r.t3_p90) : null,
    t3_n: Number(r.t3_n),
  }));

  return {
    asesores,
    lead_timeline: null,
    total_leads: Number(stuckRow?.total ?? 0),
    stuck: {
      sin_llamar: Number(stuckRow?.sin_llamar ?? 0),
      sin_agendar: Number(stuckRow?.sin_agendar ?? 0),
      sin_asistir: Number(stuckRow?.sin_asistir ?? 0),
    },
  };
}

import { db } from "../../config/database.js";

export interface ObjecionesDetalleParams {
  idCuenta: number;
  desde?: string;
  hasta?: string;
  categoria?: string;
}

export interface ObjecionDetalle {
  texto: string;
  categoria: string;
  respuesta_vendedor: string;
  contexto: string;
  asesor: string;
  fuente: "llamada" | "chat" | "videollamada";
  fecha: string;
  nombre_lead: string | null;
}

export async function getObjecionesDetalle(
  params: ObjecionesDetalleParams,
): Promise<{ total: number; objeciones: ObjecionDetalle[] }> {
  const { idCuenta, desde, hasta, categoria } = params;

  const queryParts: string[] = [];
  const values: unknown[] = [idCuenta];
  let paramIdx = 2;

  let dateFilterLlamadas = "";
  let dateFilterChats = "";
  let dateFilterAgendas = "";

  if (desde) {
    dateFilterLlamadas += ` AND l.ts >= $${paramIdx}::timestamptz`;
    dateFilterChats += ` AND c.fecha_y_hora_z >= $${paramIdx}::timestamptz`;
    dateFilterAgendas += ` AND a.fecha >= $${paramIdx}::timestamptz`;
    values.push(desde);
    paramIdx++;
  }
  if (hasta) {
    dateFilterLlamadas += ` AND l.ts < ($${paramIdx}::date + interval '1 day')`;
    dateFilterChats += ` AND c.fecha_y_hora_z < ($${paramIdx}::date + interval '1 day')`;
    dateFilterAgendas += ` AND a.fecha < ($${paramIdx}::date + interval '1 day')`;
    values.push(hasta);
    paramIdx++;
  }

  // log_llamadas: ia_objeciones is [{objecion, categoria, respuesta_vendedor, contexto}]
  queryParts.push(`
    SELECT
      obj->>'objecion' AS texto,
      obj->>'categoria' AS categoria,
      COALESCE(obj->>'respuesta_vendedor', '') AS respuesta_vendedor,
      COALESCE(obj->>'contexto', '') AS contexto,
      COALESCE(l.nombre_closer, l.closer_mail, 'Sin asesor') AS asesor,
      'llamada' AS fuente,
      l.ts AS fecha,
      l.nombre_lead
    FROM log_llamadas l,
         jsonb_array_elements(l.ia_objeciones) AS obj
    WHERE l.id_cuenta = $1
      AND l.ia_objeciones IS NOT NULL
      AND jsonb_typeof(l.ia_objeciones) = 'array'
      AND jsonb_array_length(l.ia_objeciones) > 0
      ${dateFilterLlamadas}
  `);

  // chats_logs: ia_objeciones is {objeciones: [{objecion, categoria, respuesta_vendedor, contexto}], ...}
  queryParts.push(`
    SELECT
      obj->>'objecion' AS texto,
      obj->>'categoria' AS categoria,
      COALESCE(obj->>'respuesta_vendedor', '') AS respuesta_vendedor,
      COALESCE(obj->>'contexto', '') AS contexto,
      COALESCE(c.asesor_asignado, 'Sin asesor') AS asesor,
      'chat' AS fuente,
      c.fecha_y_hora_z AS fecha,
      c.nombre_lead
    FROM chats_logs c,
         jsonb_array_elements(c.ia_objeciones->'objeciones') AS obj
    WHERE c.id_cuenta = $1
      AND c.ia_objeciones IS NOT NULL
      AND jsonb_typeof(c.ia_objeciones) = 'object'
      AND c.ia_objeciones->'objeciones' IS NOT NULL
      AND jsonb_typeof(c.ia_objeciones->'objeciones') = 'array'
      AND jsonb_array_length(c.ia_objeciones->'objeciones') > 0
      ${dateFilterChats}
  `);

  // resumenes_diarios_agendas: objeciones_ia is [{objecion, categoria, respuesta_vendedor, contexto}]
  queryParts.push(`
    SELECT
      obj->>'objecion' AS texto,
      obj->>'categoria' AS categoria,
      COALESCE(obj->>'respuesta_vendedor', '') AS respuesta_vendedor,
      COALESCE(obj->>'contexto', '') AS contexto,
      COALESCE(a.closer, 'Sin asesor') AS asesor,
      'videollamada' AS fuente,
      a.fecha AS fecha,
      a.nombre_de_lead AS nombre_lead
    FROM resumenes_diarios_agendas a,
         jsonb_array_elements(a.objeciones_ia) AS obj
    WHERE a.id_cuenta = $1
      AND a.objeciones_ia IS NOT NULL
      AND jsonb_typeof(a.objeciones_ia) = 'array'
      AND jsonb_array_length(a.objeciones_ia) > 0
      ${dateFilterAgendas}
  `);

  let fullQuery = queryParts.join("\nUNION ALL\n");

  // Wrap in a CTE so we can filter by categoria and sort
  let wrappedQuery = `WITH all_objeciones AS (${fullQuery}) SELECT * FROM all_objeciones WHERE texto IS NOT NULL AND texto != ''`;

  if (categoria) {
    wrappedQuery += ` AND LOWER(categoria) = LOWER($${paramIdx})`;
    values.push(categoria);
    paramIdx++;
  }

  wrappedQuery += " ORDER BY fecha DESC LIMIT 500";

  const result = await db.query(wrappedQuery, values);
  const rows = result.rows as Array<{
    texto: string;
    categoria: string;
    respuesta_vendedor: string;
    contexto: string;
    asesor: string;
    fuente: "llamada" | "chat" | "videollamada";
    fecha: string;
    nombre_lead: string | null;
  }>;

  return {
    total: rows.length,
    objeciones: rows.map((r) => ({
      texto: r.texto,
      categoria: (r.categoria ?? "otra").toLowerCase(),
      respuesta_vendedor: r.respuesta_vendedor ?? "",
      contexto: r.contexto ?? "",
      asesor: r.asesor,
      fuente: r.fuente,
      fecha: r.fecha,
      nombre_lead: r.nombre_lead,
    })),
  };
}

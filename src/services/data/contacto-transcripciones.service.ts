import { eq, and } from "drizzle-orm";
import { db } from "../../config/database.js";
import { drizzleDb } from "../../config/drizzle.js";
import { mapeoIdExterno } from "../../db/schema.js";
import {
  getAccountById,
  searchContactByEmail,
} from "../ghl-api.service.js";

type TipoFuente = "chat" | "llamada" | "videollamada";

interface TranscripcionItem {
  tipo: TipoFuente;
  fecha: string | null;
  transcripcion: string | null;
  analisis: string | null;
  metadata: Record<string, unknown>;
}

interface ContactoTranscripcionesResult {
  id_cliente_interno: string;
  ghl_contact_id: string;
  resolucion: "mapeo_local" | "ghl_email";
  transcripciones: TranscripcionItem[];
}

interface QueryParams {
  idCuenta: number;
  idClienteInterno: string;
  desde?: string;
  hasta?: string;
  tipo?: string;
}

async function resolveContactId(
  idCuenta: number,
  idClienteInterno: string,
): Promise<{ ghlContactId: string; resolucion: ContactoTranscripcionesResult["resolucion"] } | null> {
  const [mapeo] = await drizzleDb
    .select({ ghl_contact_id: mapeoIdExterno.ghl_contact_id })
    .from(mapeoIdExterno)
    .where(
      and(
        eq(mapeoIdExterno.id_cuenta, idCuenta),
        eq(mapeoIdExterno.id_cliente_interno, idClienteInterno),
      ),
    )
    .limit(1);

  if (mapeo) {
    return { ghlContactId: mapeo.ghl_contact_id, resolucion: "mapeo_local" };
  }

  const account = await getAccountById(idCuenta);
  if (!account?.token_ghl || !account.locationid) {
    return null;
  }

  const encodedEmail = `cliente${idClienteInterno}@autokpi.net`;
  const byEmail = await searchContactByEmail(account.locationid, encodedEmail, account.token_ghl);
  if (byEmail) {
    return { ghlContactId: byEmail.id, resolucion: "ghl_email" };
  }

  return null;
}

async function queryChats(
  idCuenta: number,
  ghlContactId: string,
  desde?: string,
  hasta?: string,
): Promise<TranscripcionItem[]> {
  let query = `
    SELECT id_evento, fecha_y_hora_z, chat, estado, ia_categoria, nombre_lead, asesor_asignado
    FROM chats_logs
    WHERE id_cuenta = $1 AND id_lead = $2
  `;
  const params: (string | number)[] = [idCuenta, ghlContactId];
  let paramIdx = 3;

  if (desde) {
    query += ` AND fecha_y_hora_z >= $${paramIdx}::timestamptz`;
    params.push(`${desde}T00:00:00Z`);
    paramIdx++;
  }
  if (hasta) {
    query += ` AND fecha_y_hora_z <= $${paramIdx}::timestamptz`;
    params.push(`${hasta}T23:59:59Z`);
    paramIdx++;
  }

  query += ` ORDER BY fecha_y_hora_z DESC`;

  const { rows } = await db.query(query, params);

  return rows.map((r: Record<string, unknown>) => {
    const chatData = r.chat as unknown;
    let transcripcionText: string | null = null;
    if (Array.isArray(chatData)) {
      transcripcionText = chatData
        .map((msg: Record<string, unknown>) => {
          const role = String(msg.role ?? msg.tipo ?? "");
          const text = String(msg.text ?? msg.mensaje ?? msg.content ?? "");
          return `[${role}] ${text}`;
        })
        .join("\n");
    } else if (typeof chatData === "string") {
      transcripcionText = chatData;
    }

    return {
      tipo: "chat" as const,
      fecha: r.fecha_y_hora_z ? String(r.fecha_y_hora_z) : null,
      transcripcion: transcripcionText,
      analisis: r.ia_categoria ? String(r.ia_categoria) : null,
      metadata: {
        id_evento: r.id_evento,
        estado: r.estado,
        nombre_lead: r.nombre_lead,
        asesor_asignado: r.asesor_asignado,
      },
    };
  });
}

async function queryLlamadas(
  idCuenta: number,
  ghlContactId: string,
  desde?: string,
  hasta?: string,
): Promise<TranscripcionItem[]> {
  let query = `
    SELECT id, ts, tipo_evento, estado_resultado, transcripcion, ia_descripcion,
           nombre_lead, closer_mail, nombre_closer, call_sid, phone
    FROM log_llamadas
    WHERE id_cuenta = $1 AND contact_id_ghl = $2
  `;
  const params: (string | number)[] = [idCuenta, ghlContactId];
  let paramIdx = 3;

  if (desde) {
    query += ` AND ts >= $${paramIdx}::timestamptz`;
    params.push(`${desde}T00:00:00Z`);
    paramIdx++;
  }
  if (hasta) {
    query += ` AND ts <= $${paramIdx}::timestamptz`;
    params.push(`${hasta}T23:59:59Z`);
    paramIdx++;
  }

  query += ` ORDER BY ts DESC`;

  const { rows } = await db.query(query, params);

  return rows.map((r: Record<string, unknown>) => ({
    tipo: "llamada" as const,
    fecha: r.ts ? String(r.ts) : null,
    transcripcion: r.transcripcion ? String(r.transcripcion) : null,
    analisis: r.ia_descripcion ? String(r.ia_descripcion) : null,
    metadata: {
      id: r.id,
      tipo_evento: r.tipo_evento,
      estado_resultado: r.estado_resultado,
      nombre_lead: r.nombre_lead,
      closer: r.nombre_closer,
      closer_mail: r.closer_mail,
      call_sid: r.call_sid,
      phone: r.phone,
    },
  }));
}

async function queryVideollamadas(
  idCuenta: number,
  ghlContactId: string,
  desde?: string,
  hasta?: string,
): Promise<TranscripcionItem[]> {
  let query = `
    SELECT id_registro_agenda, fecha, fecha_reunion, nombre_de_lead, categoria, closer,
           resumen_ia, transcripcion_fathom, link_llamada, fathom_share_url
    FROM resumenes_diarios_agendas
    WHERE id_cuenta = $1 AND ghl_contact_id = $2
  `;
  const params: (string | number)[] = [idCuenta, ghlContactId];
  let paramIdx = 3;

  if (desde) {
    query += ` AND fecha >= $${paramIdx}::timestamptz`;
    params.push(`${desde}T00:00:00Z`);
    paramIdx++;
  }
  if (hasta) {
    query += ` AND fecha <= $${paramIdx}::timestamptz`;
    params.push(`${hasta}T23:59:59Z`);
    paramIdx++;
  }

  query += ` ORDER BY fecha DESC`;

  const { rows } = await db.query(query, params);

  return rows.map((r: Record<string, unknown>) => ({
    tipo: "videollamada" as const,
    fecha: r.fecha ? String(r.fecha) : null,
    transcripcion: r.transcripcion_fathom ? String(r.transcripcion_fathom) : null,
    analisis: r.resumen_ia ? String(r.resumen_ia) : null,
    metadata: {
      id_registro_agenda: r.id_registro_agenda,
      categoria: r.categoria,
      nombre_lead: r.nombre_de_lead,
      closer: r.closer,
      fecha_reunion: r.fecha_reunion ? String(r.fecha_reunion) : null,
      link_llamada: r.link_llamada,
      fathom_share_url: r.fathom_share_url,
    },
  }));
}

export async function getContactoTranscripciones(
  params: QueryParams,
): Promise<ContactoTranscripcionesResult | null> {
  const { idCuenta, idClienteInterno, desde, hasta, tipo } = params;

  const resolved = await resolveContactId(idCuenta, idClienteInterno);
  if (!resolved) {
    return null;
  }

  const { ghlContactId, resolucion } = resolved;

  const tiposActivos = new Set<TipoFuente>(
    tipo
      ? (tipo.split(",").filter((t) => ["chat", "llamada", "videollamada"].includes(t)) as TipoFuente[])
      : ["chat", "llamada", "videollamada"],
  );

  const queries: Promise<TranscripcionItem[]>[] = [];
  if (tiposActivos.has("chat")) queries.push(queryChats(idCuenta, ghlContactId, desde, hasta));
  if (tiposActivos.has("llamada")) queries.push(queryLlamadas(idCuenta, ghlContactId, desde, hasta));
  if (tiposActivos.has("videollamada")) queries.push(queryVideollamadas(idCuenta, ghlContactId, desde, hasta));

  const results = await Promise.all(queries);
  const transcripciones = results.flat().sort((a, b) => {
    const da = a.fecha ? new Date(a.fecha).getTime() : 0;
    const db_ = b.fecha ? new Date(b.fecha).getTime() : 0;
    return db_ - da;
  });

  return {
    id_cliente_interno: idClienteInterno,
    ghl_contact_id: ghlContactId,
    resolucion,
    transcripciones,
  };
}

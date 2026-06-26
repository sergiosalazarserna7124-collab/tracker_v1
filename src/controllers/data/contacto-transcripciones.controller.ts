import type { FastifyRequest, FastifyReply } from "fastify";
import { getContactoTranscripciones } from "../../services/data/contacto-transcripciones.service.js";

interface TranscripcionesParams {
  idClienteInterno: string;
}

interface TranscripcionesQuery {
  desde?: string;
  hasta?: string;
  tipo?: string;
}

export async function handleGetTranscripciones(
  request: FastifyRequest<{ Params: TranscripcionesParams; Querystring: TranscripcionesQuery }>,
  reply: FastifyReply,
): Promise<void> {
  const { idCuenta } = request.apiKeyAuth!;
  const { idClienteInterno } = request.params;
  const { desde, hasta, tipo } = request.query;

  const result = await getContactoTranscripciones({
    idCuenta,
    idClienteInterno,
    desde,
    hasta,
    tipo,
  });

  if (!result) {
    console.warn(
      `[contacto-transcripciones] 404 — id_cliente_interno=${idClienteInterno} cuenta=${idCuenta}`,
    );
    return reply.status(404).send({
      success: false,
      error: `Contacto con ID interno '${idClienteInterno}' no encontrado`,
    });
  }

  return reply.send({
    success: true,
    id_cliente_interno: result.id_cliente_interno,
    ghl_contact_id: result.ghl_contact_id,
    resolucion: result.resolucion,
    total: result.transcripciones.length,
    transcripciones: result.transcripciones,
  });
}

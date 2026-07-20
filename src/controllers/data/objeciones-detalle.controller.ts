import type { FastifyRequest, FastifyReply } from "fastify";
import { getObjecionesDetalle } from "../../services/data/objeciones-detalle.service.js";

export interface ObjecionesDetalleQuerystring {
  id_cuenta: number;
  desde?: string;
  hasta?: string;
  categoria?: string;
}

export async function handleGetObjecionesDetalle(
  request: FastifyRequest<{ Querystring: ObjecionesDetalleQuerystring }>,
  reply: FastifyReply,
): Promise<void> {
  const { id_cuenta, desde, hasta, categoria } = request.query;

  if (!id_cuenta || isNaN(Number(id_cuenta))) {
    return reply.status(400).send({ error: "id_cuenta es requerido y debe ser un número" });
  }

  const tenantId = request.apiKeyAuth?.idCuenta;
  if (!tenantId || tenantId !== Number(id_cuenta)) {
    return reply.status(403).send({ success: false, error: "Forbidden" });
  }

  const result = await getObjecionesDetalle({
    idCuenta: Number(id_cuenta),
    desde,
    hasta,
    categoria,
  });

  return reply.send({
    success: true,
    total: result.total,
    objeciones: result.objeciones,
  });
}

import type { FastifyRequest, FastifyReply } from "fastify";
import { getMapaTiempos } from "../../services/data/mapa-tiempos.service.js";

export interface MapaTiemposQuerystring {
  id_cuenta: number;
  desde?: string;
  hasta?: string;
  asesor?: string;
  lead?: string;
}

export async function handleGetMapaTiempos(
  request: FastifyRequest<{ Querystring: MapaTiemposQuerystring }>,
  reply: FastifyReply,
): Promise<void> {
  const { id_cuenta, desde, hasta, asesor, lead } = request.query;

  if (!id_cuenta || isNaN(Number(id_cuenta))) {
    return reply.status(400).send({ error: "id_cuenta es requerido y debe ser un número" });
  }

  const tenantId = request.apiKeyAuth?.idCuenta;
  if (!tenantId || tenantId !== Number(id_cuenta)) {
    return reply.status(403).send({ success: false, error: "Forbidden" });
  }

  const result = await getMapaTiempos({
    idCuenta: Number(id_cuenta),
    desde,
    hasta,
    asesor,
    lead,
  });

  return reply.send({
    success: true,
    ...result,
  });
}

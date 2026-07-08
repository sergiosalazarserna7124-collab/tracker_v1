import type { FastifyRequest, FastifyReply } from "fastify";
import { getVideollamadasData } from "../../services/data/videollamadas.service.js";

export interface VideollamadasQuerystring {
  id_cuenta: number;
  desde?: string;
  hasta?: string;
}

export async function handleGetVideollamadas(
  request: FastifyRequest<{ Querystring: VideollamadasQuerystring }>,
  reply: FastifyReply,
): Promise<void> {
  const { id_cuenta, desde, hasta } = request.query;

  if (!id_cuenta || isNaN(Number(id_cuenta))) {
    return reply.status(400).send({ error: "id_cuenta es requerido y debe ser un número" });
  }

  const result = await getVideollamadasData({
    idCuenta: Number(id_cuenta),
    desde,
    hasta,
  });

  return reply.send({
    success: true,
    total: result.total,
    videollamadas: result.videollamadas,
  });
}

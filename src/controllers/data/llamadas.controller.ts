import type { FastifyRequest, FastifyReply } from "fastify";
import { getLlamadasData } from "../../services/data/llamadas.service.js";

export interface LlamadasQuerystring {
  id_cuenta: number;
  desde?: string;
  hasta?: string;
}

export async function handleGetLlamadas(
  request: FastifyRequest<{ Querystring: LlamadasQuerystring }>,
  reply: FastifyReply,
): Promise<void> {
  const { id_cuenta, desde, hasta } = request.query;

  if (!id_cuenta || isNaN(Number(id_cuenta))) {
    return reply.status(400).send({ error: "id_cuenta es requerido y debe ser un número" });
  }

  const result = await getLlamadasData({
    idCuenta: Number(id_cuenta),
    desde,
    hasta,
  });

  return reply.send({
    success: true,
    total: result.total,
    llamadas: result.llamadas,
  });
}

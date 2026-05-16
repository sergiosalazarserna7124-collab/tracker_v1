import type { FastifyRequest, FastifyReply } from "fastify";
import { getChatsData } from "../../services/data/chats.service.js";

export interface ChatsQuerystring {
  id_cuenta: number;
  desde?: string;
  hasta?: string;
}

export async function handleGetChats(
  request: FastifyRequest<{ Querystring: ChatsQuerystring }>,
  reply: FastifyReply,
): Promise<void> {
  const { id_cuenta, desde, hasta } = request.query;

  if (!id_cuenta || isNaN(Number(id_cuenta))) {
    return reply.status(400).send({ error: "id_cuenta es requerido y debe ser un número" });
  }

  const result = await getChatsData({
    idCuenta: Number(id_cuenta),
    desde,
    hasta,
  });

  return reply.send({
    success: true,
    total: result.total,
    chats: result.chats,
    metricasCustom: result.metricasCustom,
  });
}

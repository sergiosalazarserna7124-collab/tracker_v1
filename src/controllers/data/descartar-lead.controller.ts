import type { FastifyRequest, FastifyReply } from "fastify";
import { descartarLeads, type DescartarLeadRequest } from "../../services/data/descartar-lead.service.js";

interface DescartarBody {
  id_cuenta: number;
  contact_ids: string[];
  descartar: boolean;
}

export async function handleDescartarLead(
  request: FastifyRequest<{ Body: DescartarBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { id_cuenta, contact_ids, descartar } = request.body;

  const tenantId = request.apiKeyAuth?.idCuenta;
  if (!tenantId || tenantId !== id_cuenta) {
    return reply.status(403).send({ success: false, error: "Forbidden" });
  }

  const result = await descartarLeads({ id_cuenta, contact_ids, descartar });

  return reply.send({
    success: true,
    ...result,
  });
}

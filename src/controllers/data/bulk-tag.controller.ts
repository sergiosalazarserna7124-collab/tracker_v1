import type { FastifyRequest, FastifyReply } from "fastify";
import { bulkTagContacts, type BulkTagRequest } from "../../services/data/bulk-tag.service.js";

export async function handleBulkTag(
  request: FastifyRequest<{ Body: BulkTagRequest }>,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body;

  const tenantId = request.apiKeyAuth?.idCuenta;
  if (!tenantId || tenantId !== body.id_cuenta) {
    return reply.status(403).send({ ok: false, error: "Forbidden: API key no corresponde a la cuenta" });
  }

  if (!body.contactIds || body.contactIds.length === 0) {
    return reply.status(400).send({ ok: false, error: "contactIds no puede estar vacío" });
  }

  if (body.contactIds.length > 500) {
    return reply.status(400).send({ ok: false, error: "Máximo 500 contactos por solicitud" });
  }

  try {
    const result = await bulkTagContacts(body);
    return reply.send(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no encontrada") || msg.includes("sin token")) {
      return reply.status(404).send({ ok: false, error: msg });
    }
    if (msg.includes("Debe enviar")) {
      return reply.status(400).send({ ok: false, error: msg });
    }
    throw err;
  }
}

import type { FastifyRequest, FastifyReply } from "fastify";
import {
  procesarCalificacionWebhook,
  type AccionCalificacion,
} from "../../services/webhooks/calificacion.service.js";

interface CalificacionParams {
  locationid: string;
}

interface CalificacionBody {
  contactId: string;
  accion: AccionCalificacion;
}

export async function handleCalificacionWebhook(
  request: FastifyRequest<{ Params: CalificacionParams; Body: CalificacionBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { locationid } = request.params;
  const { contactId, accion } = request.body;

  try {
    const result = await procesarCalificacionWebhook(locationid, {
      contactId,
      accion,
    });

    return reply.send({
      success: true,
      data: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes("no encontrada")) {
      return reply.status(404).send({ success: false, error: message });
    }

    console.error("[calificacion webhook] Error:", err);
    return reply.status(500).send({ success: false, error: "Error interno" });
  }
}

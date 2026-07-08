import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  AsistenciaWebhookPayload,
  AsistenciaParamsType,
  AsistenciaEventBody,
} from "../../schemas/webhooks/asistencia.schema.js";
import { processAsistencia } from "../../services/webhooks/asistencia.service.js";
import { extractWebhookBody } from "../../utils/payload.utils.js";
import { logWebhookReceived, logWebhookResult } from "../../utils/webhook-logger.js";

export async function handleAsistenciaWebhook(
  request: FastifyRequest<{
    Params: AsistenciaParamsType;
    Body: AsistenciaWebhookPayload;
  }>,
  reply: FastifyReply,
): Promise<void> {
  const idCuenta = parseInt(request.params.id_cuenta, 10);

  if (isNaN(idCuenta) || idCuenta <= 0) {
    return reply.status(400).send({
      success: false,
      message: "id_cuenta must be a valid positive integer",
    });
  }

  const eventBody = extractWebhookBody<AsistenciaEventBody>(request.body);

  if (!eventBody) {
    return reply.status(400).send({
      success: false,
      message: "Missing or invalid asistencia event payload",
    });
  }

  if (!eventBody.email_lead && !eventBody.ghl_contact_id) {
    return reply.status(400).send({
      success: false,
      message: "Se requiere email_lead o ghl_contact_id para identificar la cita",
    });
  }

  const logId = await logWebhookReceived({
    fuente: "asistencia_manual",
    tipo_evento: eventBody.tipo,
    id_cuenta: idCuenta,
    payload_raw: request.body,
  });

  const t0 = Date.now();

  try {
    const result = await processAsistencia(idCuenta, eventBody);
    await logWebhookResult(logId, result, null, Date.now() - t0);

    if (result.action === "not_found") {
      return reply.status(404).send({
        success: false,
        message: "No se encontró cita pendiente (PDTE) para el lead indicado",
      });
    }

    return reply.status(200).send({
      success: true,
      message: `Cita marcada como ${result.categoria}`,
      id_registro_agenda: result.id_registro_agenda,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logWebhookResult(logId, null, msg, Date.now() - t0).catch(() => {});
    request.log.error({ err, idCuenta }, "[Asistencia] Error processing webhook");
    return reply.status(500).send({
      success: false,
      message: "Error procesando el webhook de asistencia",
    });
  }
}

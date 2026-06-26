import type { FastifyRequest, FastifyReply } from "fastify";
import type { ContactIntakeBodyType } from "../../schemas/webhooks/contact-intake.schema.js";
import { processContactIntake } from "../../services/webhooks/contact-intake.service.js";
import { logWebhookReceived, logWebhookResult } from "../../utils/webhook-logger.js";

export async function handleContactIntake(
  request: FastifyRequest<{ Body: ContactIntakeBodyType }>,
  reply: FastifyReply,
): Promise<void> {
  const { idCuenta } = request.apiKeyAuth!;

  const logId = await logWebhookReceived({
    fuente: "contact_intake",
    tipo_evento: "alta_contacto",
    id_cuenta: idCuenta,
    payload_raw: request.body,
  });

  const t0 = Date.now();

  try {
    const result = await processContactIntake(idCuenta, request.body);
    await logWebhookResult(logId, result, null, Date.now() - t0);
    return reply.status(result.created ? 201 : 200).send({
      success: true,
      ...result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logWebhookResult(logId, null, msg, Date.now() - t0);
    request.log.error({ err, idCuenta }, "[contact-intake] processing error");
    return reply.status(500).send({ success: false, error: msg });
  }
}

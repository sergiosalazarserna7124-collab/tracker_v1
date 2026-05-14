import type { FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import type {
  ExternalDataParamsType,
  ExternalDataBodyType,
} from "../../schemas/webhooks/external-data.schema.js";
import { drizzleDb } from "../../config/drizzle.js";
import { cuentas } from "../../db/schema.js";
import { processExternalData } from "../../services/webhooks/external-data.service.js";
import { logWebhookReceived, logWebhookResult } from "../../utils/webhook-logger.js";

export async function handleExternalData(
  request: FastifyRequest<{
    Params: ExternalDataParamsType;
    Body: ExternalDataBodyType;
  }>,
  reply: FastifyReply,
): Promise<void> {
  const { idCuenta } = request.apiKeyAuth!;
  const { locationid } = request.params;

  const [account] = await drizzleDb
    .select({ locationid: cuentas.locationid })
    .from(cuentas)
    .where(eq(cuentas.id_cuenta, idCuenta))
    .limit(1);

  if (!account || account.locationid !== locationid) {
    return reply.status(403).send({
      success: false,
      error: "locationid does not match authenticated account",
    });
  }

  const logId = await logWebhookReceived({ fuente: "external_data", tipo_evento: "metricas", location_id: locationid, id_cuenta: idCuenta, payload_raw: request.body });
  const t0 = Date.now();
  const result = await processExternalData(idCuenta, request.body.data);
  await logWebhookResult(logId, { processed: result.processed }, null, Date.now() - t0);

  return reply.status(200).send({ success: true, processed: result.processed, message: `${result.processed} metric(s) upserted` });
}

/**
 * AUT-341: Cron endpoint para recovery de webhooks sin procesar.
 *
 * POST /cron/webhook-recovery
 *
 * Detecta entradas con procesado=false >5min y:
 *  - Reintenta twilio/efectiva con <1h de antigüedad
 *  - Marca como procesado=true + error='cloud-run-timeout' las >1h
 *
 * Ejecutar cada 10 minutos desde n8n/Cloud Scheduler.
 */

import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { env } from "../../config/env.js";
import { runWebhookRecovery } from "../../services/cron/webhook-recovery.service.js";

export async function cronWebhookRecoveryRoute(app: FastifyInstance) {
  app.post(
    "/webhook-recovery",
    {
      schema: {
        headers: Type.Object(
          { "x-cron-secret": Type.String() },
          { additionalProperties: true },
        ),
      },
    },
    async (request, reply) => {
      const secret = request.headers["x-cron-secret"] as string | undefined;
      if (secret !== env.CRON_SECRET) {
        return reply.status(401).send({ success: false, error: "Unauthorized" });
      }

      try {
        const resultado = await runWebhookRecovery();
        return reply.send({ success: true, ...resultado });
      } catch (err) {
        console.error("[webhook-recovery] Error en cron:", err);
        return reply.status(500).send({ success: false, error: "Error interno en webhook-recovery" });
      }
    },
  );
}

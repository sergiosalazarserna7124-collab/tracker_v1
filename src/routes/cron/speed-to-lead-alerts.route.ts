/**
 * AUT-221: Cron endpoint para alertas de speed-to-lead.
 *
 * POST /cron/speed-to-lead-alerts
 *
 * Detecta leads sin primer contacto >60 min y >4h en cuentas activas,
 * y notifica via nota en GHL. Protegido con CRON_SECRET.
 *
 * Ejecutar cada 30 minutos desde mainautoia.
 */

import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { env } from "../../config/env.js";
import { runSpeedToLeadAlerts } from "../../services/cron/speed-to-lead-alerts.service.js";

export async function cronSpeedToLeadAlertsRoute(app: FastifyInstance) {
  app.post(
    "/speed-to-lead-alerts",
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
        const resultado = await runSpeedToLeadAlerts();
        return reply.send({ success: true, ...resultado });
      } catch (err) {
        console.error("[speed-to-lead-alerts] Error en cron:", err);
        return reply.status(500).send({ success: false, error: "Error interno en speed-to-lead-alerts" });
      }
    },
  );
}

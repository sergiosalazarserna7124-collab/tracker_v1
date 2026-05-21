/**
 * AUT-317: Cron endpoint para alertas de speed-to-lead en chats.
 *
 * POST /cron/speed-to-lead-chat-alerts
 *
 * Detecta chats sin respuesta de agente >60 min y >4h en cuentas con
 * meta_speed_chat_min configurado, y notifica via nota en GHL.
 * Protegido con CRON_SECRET.
 *
 * Ejecutar cada 30 minutos desde el cron container (cron-tracker-autokpi).
 */

import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { env } from "../../config/env.js";
import { runSpeedToLeadChatAlerts } from "../../services/cron/speed-to-lead-chat-alerts.service.js";

export async function cronSpeedToLeadChatAlertsRoute(app: FastifyInstance) {
  app.post(
    "/speed-to-lead-chat-alerts",
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
        const resultado = await runSpeedToLeadChatAlerts();
        return reply.send({ success: true, ...resultado });
      } catch (err) {
        console.error("[speed-to-lead-chat-alerts] Error en cron:", err);
        return reply.status(500).send({ success: false, error: "Error interno en speed-to-lead-chat-alerts" });
      }
    },
  );
}

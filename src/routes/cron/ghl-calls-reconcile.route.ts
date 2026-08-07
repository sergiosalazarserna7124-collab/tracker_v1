/**
 * Cron endpoint para reconciliar llamadas GHL que no llegaron por webhook
 * (GHL no dispara OutboundMessage para no-answer/busy/voicemail).
 *
 * POST /cron/ghl-calls-reconcile
 * Body opcional: { "hours": 24 } — ventana de lookback para backfills.
 *
 * El backend ya corre esto solo cada GHL_CALLS_RECONCILE_MIN minutos; este
 * endpoint sirve para disparos manuales y backfills largos.
 */

import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { env } from "../../config/env.js";
import { runGhlCallsReconcile } from "../../services/cron/ghl-calls-reconcile.service.js";

export async function cronGhlCallsReconcileRoute(app: FastifyInstance) {
  app.post<{ Body: { hours?: number } | null }>(
    "/ghl-calls-reconcile",
    {
      schema: {
        headers: Type.Object(
          { "x-cron-secret": Type.String() },
          { additionalProperties: true },
        ),
        body: Type.Optional(
          Type.Union([
            Type.Object({ hours: Type.Optional(Type.Number({ minimum: 1, maximum: 720 })) }),
            Type.Null(),
          ]),
        ),
      },
    },
    async (request, reply) => {
      const secret = request.headers["x-cron-secret"] as string | undefined;
      if (secret !== env.CRON_SECRET) {
        return reply.status(401).send({ success: false, error: "Unauthorized" });
      }

      try {
        const resultado = await runGhlCallsReconcile(request.body?.hours);
        return reply.send({ success: true, ...resultado });
      } catch (err) {
        console.error("[ghl-calls-reconcile] Error en cron:", err);
        return reply.status(500).send({ success: false, error: "Error interno en ghl-calls-reconcile" });
      }
    },
  );
}

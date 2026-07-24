import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { env } from "../../config/env.js";
import {
  estimateByokBackfill,
  runByokBackfill,
  detectAndTriggerByokBackfills,
} from "../../services/cron/byok-backfill.service.js";

const CronHeaders = Type.Object(
  { "x-cron-secret": Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);

const ByokBody = Type.Object({
  id_cuenta: Type.Optional(Type.Number({ minimum: 1 })),
  dry_run: Type.Optional(Type.Boolean()),
});

export async function byokBackfillRoute(app: FastifyInstance) {
  app.post<{
    Body: { id_cuenta?: number; dry_run?: boolean };
  }>(
    "/byok-backfill",
    {
      schema: {
        headers: CronHeaders,
        body: ByokBody,
      },
    },
    async (request, reply) => {
      const secret = request.headers["x-cron-secret"];
      if (secret !== env.CRON_SECRET) {
        return reply.status(401).send({ success: false, error: "Unauthorized" });
      }

      const { id_cuenta, dry_run } = request.body;

      if (id_cuenta) {
        if (dry_run) {
          const estimate = await estimateByokBackfill(id_cuenta);
          return reply.status(200).send({ success: true, mode: "estimate", estimate });
        }
        const result = await runByokBackfill(id_cuenta);
        return reply.status(200).send({ success: true, mode: "run", result });
      }

      if (dry_run) {
        return reply.status(400).send({
          success: false,
          error: "dry_run sin id_cuenta no está soportado. Usar id_cuenta para estimar un tenant específico.",
        });
      }

      const results = await detectAndTriggerByokBackfills();
      return reply.status(200).send({
        success: true,
        mode: "auto_detect",
        tenants_procesados: results.length,
        results,
      });
    },
  );
}

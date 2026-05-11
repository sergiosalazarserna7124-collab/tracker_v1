import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { sincronizarAds, backfillMetaAds } from "../../services/cron/sincronizar-ads.service.js";
import { env } from "../../config/env.js";

const SincronizarAdsBody = Type.Object({
  fecha: Type.Optional(Type.String({ description: "YYYY-MM-DD, defaults to yesterday (últimos 3 días para Meta)" })),
});

const BackfillAdsBody = Type.Object({
  days_back: Type.Optional(Type.Number({ description: "Días hacia atrás a sincronizar (default: 30)" })),
});

export async function cronSincronizarAdsRoute(app: FastifyInstance) {
  app.post(
    "/sincronizar-ads",
    {
      schema: {
        headers: Type.Object({ "x-cron-secret": Type.String() }),
        body: SincronizarAdsBody,
      },
    },
    async (request, reply) => {
      const secret = request.headers["x-cron-secret"];
      if (secret !== env.CRON_SECRET) {
        return reply.status(401).send({ success: false, error: "Unauthorized" });
      }
      const body = request.body as { fecha?: string };
      const result = await sincronizarAds(body.fecha);
      return reply.send(result);
    },
  );

  // Endpoint para corregir datos históricos de Meta Ads
  // Relee los últimos N días y sobrescribe con los datos ya cerrados por Meta
  app.post(
    "/backfill-meta-ads",
    {
      schema: {
        headers: Type.Object({ "x-cron-secret": Type.String() }),
        body: BackfillAdsBody,
      },
    },
    async (request, reply) => {
      const secret = request.headers["x-cron-secret"];
      if (secret !== env.CRON_SECRET) {
        return reply.status(401).send({ success: false, error: "Unauthorized" });
      }
      const body = request.body as { days_back?: number };
      const result = await backfillMetaAds(body.days_back ?? 30);
      return reply.send(result);
    },
  );
}

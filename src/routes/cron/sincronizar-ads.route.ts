import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { sincronizarAds } from "../../services/cron/sincronizar-ads.service.js";
import { env } from "../../config/env.js";

const SincronizarAdsBody = Type.Object({
  fecha: Type.Optional(Type.String({ description: "YYYY-MM-DD, defaults to yesterday" })),
});

export async function cronSincronizarAdsRoute(app: FastifyInstance) {
  app.post(
    "/sincronizar-ads",
    {
      schema: {
        headers: Type.Object({
          "x-cron-secret": Type.String(),
        }),
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
}

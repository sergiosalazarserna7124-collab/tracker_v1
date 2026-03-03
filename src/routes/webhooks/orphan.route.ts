import type { FastifyInstance } from "fastify";
import { OrphanParams, OrphanRetryBody } from "../../schemas/webhooks/orphan.schema.js";
import { handleRetryOrphan } from "../../controllers/webhooks/orphan.controller.js";

export async function orphanRoute(app: FastifyInstance) {
  app.post(
    "/retry-orphan/:id_huerfano",
    {
      schema: {
        params: OrphanParams,
        body: OrphanRetryBody,
      },
    },
    handleRetryOrphan,
  );
}

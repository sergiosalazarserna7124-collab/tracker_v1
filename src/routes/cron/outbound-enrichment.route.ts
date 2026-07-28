import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import { env } from "../../config/env.js";
import { runOutboundEnrichment } from "../../services/cron/outbound-enrichment.service.js";

const CronHeaders = Type.Object(
  { "x-cron-secret": Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);

async function handleOutboundEnrichment(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const secret = request.headers["x-cron-secret"];
  if (secret !== env.CRON_SECRET) {
    return reply.status(401).send({ success: false, error: "Unauthorized" });
  }

  try {
    const result = await runOutboundEnrichment();
    return reply.send({ success: true, ...result });
  } catch (err) {
    console.error("[handleOutboundEnrichment] Error:", err);
    return reply.status(500).send({ success: false, error: "Error interno en outbound-enrichment" });
  }
}

export async function cronOutboundEnrichmentRoute(app: FastifyInstance) {
  app.post(
    "/outbound-enrichment",
    {
      schema: {
        headers: CronHeaders,
      },
    },
    handleOutboundEnrichment,
  );
}

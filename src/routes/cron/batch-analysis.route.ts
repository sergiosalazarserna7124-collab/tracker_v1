import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import { env } from "../../config/env.js";
import { runBatchAnalysis } from "../../services/cron/batch-analysis.service.js";

// ─── Schema ───────────────────────────────────────────────────────────────────

const CronHeaders = Type.Object(
  { "x-cron-secret": Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);

const BatchAnalysisBody = Type.Object({
  account_ids: Type.Optional(Type.Array(Type.Number({ minimum: 1 }))),
});

type BatchAnalysisPayload = Static<typeof BatchAnalysisBody>;

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handleBatchAnalysis(
  request: FastifyRequest<{ Body: BatchAnalysisPayload }>,
  reply: FastifyReply,
) {
  const secret = request.headers["x-cron-secret"];
  if (secret !== env.CRON_SECRET) {
    return reply.status(401).send({ success: false, error: "Unauthorized" });
  }

  const { account_ids } = (request.body as BatchAnalysisPayload | null) ?? {};

  try {
    const result = await runBatchAnalysis(account_ids);
    return reply.send({ success: true, ...result });
  } catch (err) {
    console.error("[handleBatchAnalysis] Error:", err);
    return reply.status(500).send({ success: false, error: "Error interno en batch-analizar-conversaciones" });
  }
}

// ─── Registro de ruta ─────────────────────────────────────────────────────────

export async function cronBatchAnalysisRoute(app: FastifyInstance) {
  // n8n y Cloud Scheduler envían POST sin Content-Type — usar '*' como string
  // (no array) que es el catch-all real de Fastify para content-type undefined.
  app.addContentTypeParser(
    "*",
    { parseAs: "string" },
    (_req, body, done) => {
      const raw = typeof body === "string" ? body.trim() : "";
      if (raw) {
        try {
          done(null, JSON.parse(raw));
        } catch {
          done(null, {});
        }
      } else {
        done(null, {});
      }
    },
  );

  // Cuando no hay body (Content-Length: 0 o header ausente), Fastify omite el
  // parser y deja request.body como undefined. Normalizar a {} antes de validar.
  app.addHook("preValidation", async (request) => {
    if (request.body == null) {
      (request as unknown as { body: Record<string, never> }).body = {};
    }
  });

  app.post(
    "/batch-analizar-conversaciones",
    {
      schema: {
        headers: CronHeaders,
        body: BatchAnalysisBody,
      },
    },
    handleBatchAnalysis,
  );
}

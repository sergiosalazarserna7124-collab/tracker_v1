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
  // n8n envía POST sin Content-Type: application/json — aceptar cualquier tipo
  // y parsear el body como JSON si es posible; sino, devolver objeto vacío.
  app.addContentTypeParser(
    ["text/plain", "application/x-www-form-urlencoded", "*"],
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

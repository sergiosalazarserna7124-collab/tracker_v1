import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { env } from "../../config/env.js";
import { runGeminiBackfill, type BackfillTable } from "../../services/cron/gemini-backfill.service.js";
import { db as pgPool } from "../../config/database.js";

const BACKFILL_LOCK_ID = 839_301;

const BackfillBody = Type.Object({
  tabla: Type.Optional(
    Type.Union([
      Type.Literal("log_llamadas"),
      Type.Literal("resumenes_diarios_agendas"),
      Type.Literal("chats_logs"),
      Type.Literal("all"),
    ]),
  ),
  account_ids: Type.Optional(Type.Array(Type.Number({ minimum: 1 }))),
  days_back: Type.Optional(Type.Number({ minimum: 1, maximum: 365 })),
});

const CronHeaders = Type.Object(
  { "x-cron-secret": Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);

export async function cronGeminiBackfillRoute(app: FastifyInstance) {
  app.post<{
    Body: { tabla?: BackfillTable; account_ids?: number[]; days_back?: number };
  }>(
    "/gemini-backfill",
    {
      schema: {
        headers: CronHeaders,
        body: BackfillBody,
      },
    },
    async (request, reply) => {
      const secret = request.headers["x-cron-secret"];
      if (secret !== env.CRON_SECRET) {
        return reply.status(401).send({ success: false, error: "Unauthorized" });
      }

      const client = await pgPool.connect();
      try {
        await client.query("BEGIN");
        const lockResult = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_xact_lock($1) AS locked",
          [BACKFILL_LOCK_ID],
        );
        if (!lockResult.rows[0]?.locked) {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            success: false,
            error: "backfill Gemini ya en curso (lock global)",
          });
        }

        try {
          const { tabla = "all", account_ids, days_back = 60 } = request.body;
          const results = await runGeminiBackfill(tabla, account_ids, days_back);
          await client.query("COMMIT");
          return reply.send({ success: true, results });
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          const message = err instanceof Error ? err.message : "Error interno";
          console.error("[gemini-backfill] Error:", err);
          return reply.status(500).send({ success: false, error: message });
        }
      } finally {
        client.release();
      }
    },
  );
}

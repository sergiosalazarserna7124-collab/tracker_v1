import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { env } from "../../config/env.js";
import { runGeminiBackfill, type BackfillTable } from "../../services/cron/gemini-backfill.service.js";
import { db as pgPool } from "../../config/database.js";

const TABLE_LOCK_IDS: Record<string, number> = {
  log_llamadas: 839_302,
  resumenes_diarios_agendas: 839_303,
  chats_logs: 839_304,
};

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
  days_back: Type.Optional(Type.Number({ minimum: 1, maximum: 730 })),
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

      const { tabla = "all", account_ids, days_back } = request.body;

      const tables: Array<"log_llamadas" | "resumenes_diarios_agendas" | "chats_logs"> =
        tabla === "all"
          ? ["log_llamadas", "resumenes_diarios_agendas", "chats_logs"]
          : [tabla];

      async function processTable(t: "log_llamadas" | "resumenes_diarios_agendas" | "chats_logs"): Promise<{ tabla: string; locked: boolean; result?: unknown }> {
        const lockId = TABLE_LOCK_IDS[t];
        let client: import("pg").PoolClient;
        try {
          client = await pgPool.connect();
        } catch (err) {
          console.error(`[gemini-backfill] connect() falló para ${t}:`, err);
          return { tabla: t, locked: false, result: { error: "No se pudo obtener conexión del pool" } };
        }
        try {
          await client.query("BEGIN");
          const lockResult = await client.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_xact_lock($1) AS locked",
            [lockId],
          );
          if (!lockResult.rows[0]?.locked) {
            await client.query("ROLLBACK");
            return { tabla: t, locked: false };
          }

          try {
            const tableResults = await runGeminiBackfill(t, account_ids, days_back);
            await client.query("COMMIT");
            return { tabla: t, locked: true, result: tableResults[0] };
          } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            console.error(`[gemini-backfill] Error en ${t}:`, err);
            return { tabla: t, locked: true, result: { error: err instanceof Error ? err.message : "Error interno" } };
          }
        } finally {
          client.release();
        }
      }

      const results = await Promise.all(tables.map(processTable));

      const allSkipped = results.every((r) => !r.locked);
      return reply.status(allSkipped ? 409 : 200).send({
        success: true,
        results,
      });
    },
  );
}

import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { env } from "../../config/env.js";
import { runGeminiBackfill } from "../../services/cron/gemini-backfill.service.js";
import { db as pgPool } from "../../config/database.js";

const TABLE_LOCK_IDS: Record<string, number> = {
  log_llamadas: 839_302,
  resumenes_diarios_agendas: 839_303,
  chats_logs: 839_304,
};

type SingleTable = "log_llamadas" | "resumenes_diarios_agendas" | "chats_logs";

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
    Body: { tabla?: string; account_ids?: number[]; days_back?: number };
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

      if (tabla === "all") {
        console.warn(`[gemini-backfill] Rechazado: tabla="all" desde ${request.ip}. Usar llamadas single-table.`);
        return reply.status(400).send({
          success: false,
          error: 'tabla="all" ya no está soportado. Enviar una request por tabla: log_llamadas, resumenes_diarios_agendas, chats_logs.',
        });
      }

      const t = tabla as SingleTable;
      const lockId = TABLE_LOCK_IDS[t];

      let client: import("pg").PoolClient;
      try {
        client = await pgPool.connect();
      } catch (err) {
        console.error(`[gemini-backfill] connect() falló para ${t}:`, err);
        return reply.status(500).send({
          success: false,
          error: "No se pudo obtener conexión del pool",
        });
      }

      try {
        const lockResult = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS locked",
          [lockId],
        );

        if (!lockResult.rows[0]?.locked) {
          client.release();
          return reply.status(409).send({
            success: true,
            results: [{ tabla: t, locked: false }],
          });
        }

        let result: unknown;
        try {
          const tableResults = await runGeminiBackfill(t, account_ids, days_back);
          result = tableResults[0];
        } catch (err) {
          console.error(`[gemini-backfill] Error en ${t}:`, err);
          result = { error: err instanceof Error ? err.message : "Error interno" };
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [lockId]).catch(() => {});
          client.release();
        }

        return reply.status(200).send({
          success: true,
          results: [{ tabla: t, locked: true, result }],
        });
      } catch (err) {
        await client.query("SELECT pg_advisory_unlock($1)", [lockId]).catch(() => {});
        client.release();
        console.error(`[gemini-backfill] Error inesperado en ${t}:`, err);
        return reply.status(500).send({
          success: false,
          error: err instanceof Error ? err.message : "Error interno",
        });
      }
    },
  );
}

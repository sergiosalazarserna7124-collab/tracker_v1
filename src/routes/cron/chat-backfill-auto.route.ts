import type { FastifyInstance } from "fastify";
import { CronHeaders } from "../../schemas/cron/daily-tasks.schema.js";
import { env } from "../../config/env.js";
import { db as pgPool } from "../../config/database.js";
import { runChatBackfillAuto } from "../../services/cron/chat-backfill-auto.service.js";

const LOCK_ID = 839_321;

export async function cronChatBackfillAutoRoute(app: FastifyInstance) {
  app.post(
    "/chat-backfill-auto",
    {
      schema: {
        headers: CronHeaders,
      },
    },
    async (request, reply) => {
      const secret = request.headers["x-cron-secret"];
      if (secret !== env.CRON_SECRET) {
        return reply.status(401).send({ success: false, error: "Unauthorized" });
      }

      let client: import("pg").PoolClient;
      try {
        client = await pgPool.connect();
      } catch (err) {
        console.error("[chat-backfill-auto] connect() falló:", err);
        return reply.status(500).send({
          success: false,
          error: "No se pudo obtener conexión del pool",
        });
      }

      try {
        await client.query("SET idle_session_timeout = '900s'");

        const lockResult = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS locked",
          [LOCK_ID],
        );

        if (!lockResult.rows[0]?.locked) {
          await client.query("RESET idle_session_timeout").catch(() => {});
          client.release();
          return reply.status(409).send({
            success: true,
            result: { locked: false, message: "Another invocation is already running" },
          });
        }

        let result: unknown;
        try {
          result = await runChatBackfillAuto();
        } catch (err) {
          console.error("[chat-backfill-auto] Error:", err);
          result = { error: err instanceof Error ? err.message : "Error interno" };
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
          await client.query("RESET idle_session_timeout").catch(() => {});
          client.release();
        }

        return reply.send({ success: true, ...(result as object) });
      } catch (err) {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
        await client.query("RESET idle_session_timeout").catch(() => {});
        client.release();
        console.error("[chat-backfill-auto] Error inesperado:", err);
        return reply.status(500).send({
          success: false,
          error: err instanceof Error ? err.message : "Error interno",
        });
      }
    },
  );
}

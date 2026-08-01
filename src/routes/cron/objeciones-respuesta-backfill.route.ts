import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { env } from "../../config/env.js";
import { runObjecionesBackfill, type BackfillTabla } from "../../services/cron/objeciones-respuesta-backfill.service.js";
import { db as pgPool } from "../../config/database.js";

const TABLE_LOCK_IDS: Record<BackfillTabla, number> = {
  log_llamadas: 839_310,
  chats_logs: 839_311,
  resumenes_diarios_agendas: 839_312,
};

const BackfillBody = Type.Object({
  tabla: Type.Union([
    Type.Literal("log_llamadas"),
    Type.Literal("chats_logs"),
    Type.Literal("resumenes_diarios_agendas"),
  ]),
  days_back: Type.Optional(Type.Number({ minimum: 1, maximum: 365 })),
});

const CronHeaders = Type.Object(
  { "x-cron-secret": Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);

export async function cronObjecionesBackfillRoute(app: FastifyInstance) {
  app.post<{
    Body: { tabla: BackfillTabla; days_back?: number };
  }>(
    "/objeciones-respuesta-backfill",
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

      const { tabla, days_back } = request.body;
      const lockId = TABLE_LOCK_IDS[tabla];

      let client: import("pg").PoolClient;
      try {
        client = await pgPool.connect();
      } catch (err) {
        console.error(`[objeciones-backfill] connect() falló para ${tabla}:`, err);
        return reply.status(500).send({
          success: false,
          error: "No se pudo obtener conexión del pool",
        });
      }

      try {
        // Auto-liberación del advisory lock si el proceso muere sin correr el finally.
        // Cloud Run puede SIGKILL el contenedor a mitad de un backfill (p.ej. durante un
        // deploy); la conexión pg queda colgada y el lock de SESIÓN retenido hasta que TCP
        // keepalive detecte el peer muerto (~2h por defecto). idle_session_timeout cierra la
        // conexión inactiva y libera el lock. Debe ser > MAX_RUNTIME_MS (210s) del servicio,
        // porque este client queda idle todo el backfill (el trabajo corre sobre pgPool).
        await client.query("SET idle_session_timeout = '600s'");

        const lockResult = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS locked",
          [lockId],
        );

        if (!lockResult.rows[0]?.locked) {
          await client.query("RESET idle_session_timeout").catch(() => {});
          client.release();
          return reply.status(409).send({
            success: true,
            result: { tabla, locked: false },
          });
        }

        let result: unknown;
        try {
          result = await runObjecionesBackfill(tabla, days_back);
        } catch (err) {
          console.error(`[objeciones-backfill] Error en ${tabla}:`, err);
          result = { error: err instanceof Error ? err.message : "Error interno" };
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [lockId]).catch(() => {});
          await client.query("RESET idle_session_timeout").catch(() => {});
          client.release();
        }

        return reply.status(200).send({ success: true, result });
      } catch (err) {
        await client.query("SELECT pg_advisory_unlock($1)", [lockId]).catch(() => {});
        await client.query("RESET idle_session_timeout").catch(() => {});
        client.release();
        console.error(`[objeciones-backfill] Error inesperado en ${tabla}:`, err);
        return reply.status(500).send({
          success: false,
          error: err instanceof Error ? err.message : "Error interno",
        });
      }
    },
  );
}

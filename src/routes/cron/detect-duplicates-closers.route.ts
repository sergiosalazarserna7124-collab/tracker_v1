/**
 * AUT-273: Cron para detectar closers duplicados en todas las cuentas activas.
 *
 * POST /cron/detect-duplicates-closers
 *
 * Itera sobre cuentas con actividad en los últimos 30 días y llama a
 * detectDuplicates() por cada una. Protegido con CRON_SECRET.
 */

import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { db as pgPool } from "../../config/database.js";
import { detectDuplicates } from "../../services/ai/closer-dedup.service.js";
import { env } from "../../config/env.js";

export async function cronDetectDuplicatesClosersRoute(app: FastifyInstance) {
  app.post(
    "/detect-duplicates-closers",
    {
      schema: {
        headers: Type.Object({ "x-cron-secret": Type.String() }),
      },
    },
    async (request, reply) => {
      const secret = request.headers["x-cron-secret"];
      if (secret !== env.CRON_SECRET) {
        return reply.status(401).send({ success: false, error: "Unauthorized" });
      }

      // Cuentas con llamadas en los últimos 30 días
      const result = await pgPool.query<{ id_cuenta: number }>(
        `SELECT DISTINCT id_cuenta
         FROM log_llamadas
         WHERE ts >= NOW() - INTERVAL '30 days'
         ORDER BY id_cuenta`,
      );

      const cuentaIds = result.rows.map((r) => r.id_cuenta);
      console.info(`[detect-duplicates-closers] Procesando ${cuentaIds.length} cuentas activas`);

      let totalSugerencias = 0;
      let errores = 0;

      for (const idCuenta of cuentaIds) {
        try {
          const n = await detectDuplicates(idCuenta);
          totalSugerencias += n;
        } catch (err) {
          errores++;
          console.error(`[detect-duplicates-closers] Error cuenta ${idCuenta}:`, err);
        }
      }

      console.info(
        `[detect-duplicates-closers] Listo: ${totalSugerencias} sugerencias creadas, ${errores} errores`,
      );

      return reply.send({
        success: true,
        cuentas_procesadas: cuentaIds.length,
        sugerencias_creadas: totalSugerencias,
        errores,
      });
    },
  );
}

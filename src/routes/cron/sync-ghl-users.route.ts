/**
 * Sync de usuarios GHL → usuarios_dashboard.
 *
 * POST /cron/sync-ghl-users            → todas las cuentas con app instalada
 * POST /cron/sync-ghl-users {id_cuenta} → solo esa cuenta (sync manual)
 *
 * Protegido con CRON_SECRET.
 */

import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { db } from "../../config/database.js";
import { env } from "../../config/env.js";
import {
  syncAllGhlUsers,
  syncUsersForLocation,
} from "../../services/ghl-users-sync.service.js";

export async function cronSyncGhlUsersRoute(app: FastifyInstance) {
  app.post<{ Body: { id_cuenta?: number } | null }>(
    "/sync-ghl-users",
    {
      schema: {
        headers: Type.Object({ "x-cron-secret": Type.String() }),
        body: Type.Union([
          Type.Object({ id_cuenta: Type.Optional(Type.Integer()) }),
          Type.Null(),
        ]),
      },
    },
    async (request, reply) => {
      const secret = request.headers["x-cron-secret"];
      if (secret !== env.CRON_SECRET) {
        return reply.status(401).send({ success: false, error: "Unauthorized" });
      }

      const idCuenta = request.body?.id_cuenta;

      if (idCuenta != null) {
        const { rows } = await db.query<{ location_id: string }>(
          `SELECT location_id
             FROM ghl_oauth_tokens
            WHERE id_cuenta = $1 AND location_id NOT LIKE 'company:%'
            LIMIT 1`,
          [idCuenta],
        );
        if (!rows[0]) {
          return reply.status(404).send({
            success: false,
            error: `La cuenta ${idCuenta} no tiene la app de GHL instalada`,
          });
        }
        const result = await syncUsersForLocation(idCuenta, rows[0].location_id);
        return reply.send({ success: !result.error, resultados: [result] });
      }

      const resultados = await syncAllGhlUsers();
      const errores = resultados.filter((r) => r.error).length;
      return reply.send({
        success: true,
        cuentas_procesadas: resultados.length,
        errores,
        resultados,
      });
    },
  );
}

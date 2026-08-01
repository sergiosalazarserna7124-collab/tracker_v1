import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { cuentas } from "../../db/schema.js";
import { env } from "../../config/env.js";

export async function updateRuleExcluyeRoute(app: FastifyInstance) {
  app.post<{
    Body: {
      id_cuenta: number;
      rule_id: string;
      excluye: string[];
    };
  }>(
    "/update-rule-excluye",
    {
      schema: {
        headers: Type.Object({ "x-cron-secret": Type.String() }),
        body: Type.Object({
          id_cuenta: Type.Number(),
          rule_id: Type.String(),
          excluye: Type.Array(Type.String()),
        }),
      },
    },
    async (request, reply) => {
      const secret = request.headers["x-cron-secret"];
      if (secret !== env.CRON_SECRET) {
        return reply.status(401).send({ success: false, error: "Unauthorized" });
      }

      const { id_cuenta, rule_id, excluye } = request.body;

      const [account] = await drizzleDb
        .select({ reglas_etiquetas: cuentas.reglas_etiquetas })
        .from(cuentas)
        .where(eq(cuentas.id_cuenta, id_cuenta))
        .limit(1);

      if (!account) {
        return reply.status(404).send({ success: false, error: `Account ${id_cuenta} not found` });
      }

      const reglas = account.reglas_etiquetas;
      if (!Array.isArray(reglas)) {
        return reply.status(400).send({ success: false, error: "reglas_etiquetas is not an array" });
      }

      const ruleIndex = reglas.findIndex(
        (r: Record<string, unknown>) => r.id === rule_id,
      );

      if (ruleIndex === -1) {
        return reply.status(404).send({
          success: false,
          error: `Rule ${rule_id} not found in account ${id_cuenta}`,
        });
      }

      const prevExcluye = (reglas[ruleIndex] as Record<string, unknown>).excluye ?? null;

      const updatedReglas = [...reglas];
      updatedReglas[ruleIndex] = {
        ...(updatedReglas[ruleIndex] as Record<string, unknown>),
        excluye,
      };

      await drizzleDb
        .update(cuentas)
        .set({ reglas_etiquetas: updatedReglas })
        .where(eq(cuentas.id_cuenta, id_cuenta));

      return reply.send({
        success: true,
        id_cuenta,
        rule_id,
        prev_excluye: prevExcluye,
        new_excluye: excluye,
      });
    },
  );
}

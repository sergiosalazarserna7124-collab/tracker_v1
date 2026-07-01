import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { agendas, cuentas } from "../../db/schema.js";
import { env } from "../../config/env.js";
import { evaluateReglas, type DynamicValueContext } from "../../services/ai/reglas-evaluator.service.js";

export async function reprocessReglasRoute(app: FastifyInstance) {
  app.post<{
    Body: { id_registro_agenda: number };
  }>(
    "/reprocess-reglas",
    {
      schema: {
        headers: Type.Object({ "x-cron-secret": Type.String() }),
        body: Type.Object({
          id_registro_agenda: Type.Number(),
        }),
      },
    },
    async (request, reply) => {
      const secret = request.headers["x-cron-secret"];
      if (secret !== env.CRON_SECRET) {
        return reply.status(401).send({ success: false, error: "Unauthorized" });
      }

      const { id_registro_agenda } = request.body;

      const [record] = await drizzleDb
        .select({
          id: agendas.id_registro_agenda,
          id_cuenta: agendas.id_cuenta,
          nombre_de_lead: agendas.nombre_de_lead,
          transcript: agendas.transcripcion_fathom,
          ghl_contact_id: agendas.ghl_contact_id,
          tags_internos: agendas.tags_internos,
        })
        .from(agendas)
        .where(eq(agendas.id_registro_agenda, id_registro_agenda))
        .limit(1);

      if (!record) {
        return reply.status(404).send({ success: false, error: "Record not found" });
      }

      if (!record.transcript) {
        return reply.status(400).send({
          success: false,
          error: "Record has no transcript — evaluator needs text to match rules",
          nombre_lead: record.nombre_de_lead,
        });
      }

      const [account] = await drizzleDb
        .select({
          token_ghl: cuentas.token_ghl,
          prompt_ventas: cuentas.prompt_ventas,
          openai_api_key: cuentas.openai_api_key,
          reglas_etiquetas: cuentas.reglas_etiquetas,
        })
        .from(cuentas)
        .where(eq(cuentas.id_cuenta, record.id_cuenta))
        .limit(1);

      if (!account) {
        return reply.status(404).send({ success: false, error: `Account ${record.id_cuenta} not found` });
      }

      const dynCtx: DynamicValueContext = {
        contactId: record.ghl_contact_id,
        bearerToken: account.token_ghl,
      };

      const result = await evaluateReglas(
        record.transcript,
        account.reglas_etiquetas,
        "meeting",
        account.prompt_ventas ?? null,
        account.openai_api_key,
        record.id_cuenta,
        dynCtx,
      );

      const existingTags = Array.isArray(record.tags_internos) ? record.tags_internos as string[] : [];
      const mergedTags = [...new Set([...existingTags, ...result.matched_tags])];

      await drizzleDb
        .update(agendas)
        .set({ tags_internos: mergedTags })
        .where(eq(agendas.id_registro_agenda, id_registro_agenda));

      return reply.send({
        success: true,
        id_registro_agenda,
        nombre_lead: record.nombre_de_lead,
        ghl_contact_id: record.ghl_contact_id,
        matched_tags: result.matched_tags,
        matched_rules: result.matched_rules,
        tags_internos_final: mergedTags,
      });
    },
  );
}

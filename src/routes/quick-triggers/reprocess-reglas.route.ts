import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { agendas, cuentas, logLlamadas } from "../../db/schema.js";
import { env } from "../../config/env.js";
import { evaluateReglas, type DynamicValueContext } from "../../services/ai/reglas-evaluator.service.js";

interface NormalizedRecord {
  id: number;
  id_cuenta: number;
  nombre_lead: string | null;
  transcript: string | null;
  ghl_contact_id: string | null;
  tags_internos: unknown;
}

export async function reprocessReglasRoute(app: FastifyInstance) {
  app.post<{
    Body: {
      id_registro_agenda?: number;
      id_log_llamada?: number;
      mode?: "replace" | "merge";
    };
  }>(
    "/reprocess-reglas",
    {
      schema: {
        headers: Type.Object({ "x-cron-secret": Type.String() }),
        body: Type.Object({
          id_registro_agenda: Type.Optional(Type.Number()),
          id_log_llamada: Type.Optional(Type.Number()),
          mode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("merge")])),
        }),
      },
    },
    async (request, reply) => {
      const secret = request.headers["x-cron-secret"];
      if (secret !== env.CRON_SECRET) {
        return reply.status(401).send({ success: false, error: "Unauthorized" });
      }

      const { id_registro_agenda, id_log_llamada, mode = "replace" } = request.body;

      if (!id_registro_agenda && !id_log_llamada) {
        return reply.status(400).send({
          success: false,
          error: "Provide either id_registro_agenda or id_log_llamada",
        });
      }
      if (id_registro_agenda && id_log_llamada) {
        return reply.status(400).send({
          success: false,
          error: "Provide only one of id_registro_agenda or id_log_llamada, not both",
        });
      }

      const isCall = !!id_log_llamada;
      const source: "call" | "meeting" = isCall ? "call" : "meeting";

      let record: NormalizedRecord | undefined;

      if (isCall) {
        const [row] = await drizzleDb
          .select({
            id: logLlamadas.id,
            id_cuenta: logLlamadas.id_cuenta,
            nombre_lead: logLlamadas.nombre_lead,
            transcript: logLlamadas.transcripcion,
            ghl_contact_id: logLlamadas.contact_id_ghl,
            tags_internos: logLlamadas.tags_internos,
          })
          .from(logLlamadas)
          .where(eq(logLlamadas.id, id_log_llamada))
          .limit(1);
        record = row;
      } else {
        const [row] = await drizzleDb
          .select({
            id: agendas.id_registro_agenda,
            id_cuenta: agendas.id_cuenta,
            nombre_lead: agendas.nombre_de_lead,
            transcript: agendas.transcripcion_fathom,
            ghl_contact_id: agendas.ghl_contact_id,
            tags_internos: agendas.tags_internos,
          })
          .from(agendas)
          .where(eq(agendas.id_registro_agenda, id_registro_agenda!))
          .limit(1);
        record = row;
      }

      if (!record) {
        return reply.status(404).send({ success: false, error: "Record not found" });
      }

      if (!record.transcript) {
        return reply.status(400).send({
          success: false,
          error: "Record has no transcript — evaluator needs text to match rules",
          nombre_lead: record.nombre_lead,
        });
      }

      const [account] = await drizzleDb
        .select({
          token_ghl: cuentas.token_ghl,
          prompt_ventas: cuentas.prompt_ventas,
          prompt_llamadas: cuentas.prompt_llamadas,
          prompt_videollamadas: cuentas.prompt_videollamadas,
          openai_api_key: cuentas.openai_api_key,
          reglas_etiquetas: cuentas.reglas_etiquetas,
          locationid: cuentas.locationid,
        })
        .from(cuentas)
        .where(eq(cuentas.id_cuenta, record.id_cuenta))
        .limit(1);

      if (!account) {
        return reply.status(404).send({ success: false, error: `Account ${record.id_cuenta} not found` });
      }

      const promptForChannel = isCall
        ? (account.prompt_llamadas ?? account.prompt_ventas ?? null)
        : (account.prompt_videollamadas ?? account.prompt_ventas ?? null);

      const dynCtx: DynamicValueContext = {
        contactId: record.ghl_contact_id,
        bearerToken: account.token_ghl,
        locationId: account.locationid,
      };

      const result = await evaluateReglas(
        record.transcript,
        account.reglas_etiquetas,
        source,
        promptForChannel,
        account.openai_api_key,
        record.id_cuenta,
        dynCtx,
      );

      let finalTags: string[];
      if (mode === "merge") {
        const existingTags = Array.isArray(record.tags_internos) ? record.tags_internos as string[] : [];
        finalTags = [...new Set([...existingTags, ...result.matched_tags])];
      } else {
        finalTags = result.matched_tags;
      }

      if (isCall) {
        await drizzleDb
          .update(logLlamadas)
          .set({ tags_internos: finalTags })
          .where(eq(logLlamadas.id, id_log_llamada!));
      } else {
        await drizzleDb
          .update(agendas)
          .set({ tags_internos: finalTags })
          .where(eq(agendas.id_registro_agenda, id_registro_agenda!));
      }

      return reply.send({
        success: true,
        ...(isCall ? { id_log_llamada } : { id_registro_agenda }),
        source,
        mode,
        nombre_lead: record.nombre_lead,
        ghl_contact_id: record.ghl_contact_id,
        matched_tags: result.matched_tags,
        matched_rules: result.matched_rules,
        tags_internos_prev: record.tags_internos,
        tags_internos_final: finalTags,
      });
    },
  );
}

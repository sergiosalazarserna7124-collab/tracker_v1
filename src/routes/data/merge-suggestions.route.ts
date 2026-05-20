/**
 * AUT-272: Endpoints para listar y resolver sugerencias de merge de closers duplicados.
 *
 * GET  /api/data/asesores/merge-suggestions?status=pending
 * POST /api/data/asesores/merge-suggestions/:id/accept
 * POST /api/data/asesores/merge-suggestions/:id/reject
 * POST /api/data/asesores/detect-duplicates
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import { db as pgPool } from "../../config/database.js";
import { drizzleDb } from "../../config/drizzle.js";
import { cuentas } from "../../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { detectDuplicates } from "../../services/ai/closer-dedup.service.js";
import type { CloserMergeRule, CloserAlias } from "../../services/ai/closer-dedup.service.js";

// ─── Tipos ─────────────────────────────────────────────────────────────────────

interface GetSuggestionsQuery {
  status?: string;
}

interface SuggestionParams {
  id: number;
}

interface AcceptBody {
  canonical_email?: string;
  canonical_nombre?: string;
}

interface MergeSuggestionRow {
  id: number;
  id_cuenta: number;
  aliases: Array<{ email?: string; nombre: string }>;
  canonical_nombre: string;
  canonical_email: string | null;
  status: string;
  created_at: Date;
  resuelto_at: Date | null;
}

// ─── Helper: normalización de cadenas ─────────────────────────────────────────

function normalizeStr(s: string): string {
  return s.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// ─── Ruta ─────────────────────────────────────────────────────────────────────

export async function asesoresMergeSuggestionsRoute(app: FastifyInstance) {
  // ── GET /merge-suggestions?status=pending ─────────────────────────────────
  app.get<{ Querystring: GetSuggestionsQuery }>(
    "/merge-suggestions",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["pending", "accepted", "rejected"] },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: GetSuggestionsQuery }>, reply: FastifyReply) => {
      if (!request.apiKeyAuth) return reply.status(401).send({ ok: false, error: "Unauthorized" });
      const idCuenta = request.apiKeyAuth.idCuenta;
      const status = request.query.status ?? "pending";

      const rows = await pgPool.query<MergeSuggestionRow>(
        `SELECT id, id_cuenta, aliases, canonical_nombre, canonical_email,
                status, created_at, resuelto_at
         FROM closer_merge_suggestions
         WHERE id_cuenta = $1 AND status = $2
         ORDER BY created_at DESC`,
        [idCuenta, status],
      );

      return reply.send({ ok: true, suggestions: rows.rows });
    },
  );

  // ── POST /merge-suggestions/:id/accept ────────────────────────────────────
  app.post<{ Params: SuggestionParams; Body: AcceptBody }>(
    "/merge-suggestions/:id/accept",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer" } },
        },
        body: {
          type: "object",
          properties: {
            canonical_email: { type: "string" },
            canonical_nombre: { type: "string" },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: SuggestionParams; Body: AcceptBody }>, reply: FastifyReply) => {
      if (!request.apiKeyAuth) return reply.status(401).send({ ok: false, error: "Unauthorized" });
      const idCuenta = request.apiKeyAuth.idCuenta;
      const { id } = request.params;
      const { canonical_email: bodyEmail, canonical_nombre: bodyNombre } = request.body ?? {};

      // 1. Validar que el id pertenece a la cuenta
      const suggResult = await pgPool.query<MergeSuggestionRow>(
        `SELECT * FROM closer_merge_suggestions WHERE id = $1 AND id_cuenta = $2 LIMIT 1`,
        [id, idCuenta],
      );

      const suggestion = suggResult.rows[0];
      if (!suggestion) {
        return reply.status(404).send({ ok: false, error: "Sugerencia no encontrada" });
      }
      if (suggestion.status !== "pending") {
        return reply.status(409).send({ ok: false, error: `La sugerencia ya está ${suggestion.status}` });
      }

      const canonicalNombre = bodyNombre ?? suggestion.canonical_nombre;
      const canonicalEmail = bodyEmail || suggestion.canonical_email || null;
      const aliases = suggestion.aliases as CloserAlias[];

      // 2. Leer reglas actuales de la cuenta
      const [cuentaRow] = await drizzleDb
        .select({ closer_merge_rules: cuentas.closer_merge_rules })
        .from(cuentas)
        .where(eq(cuentas.id_cuenta, idCuenta))
        .limit(1);

      const existingRules = (cuentaRow?.closer_merge_rules as CloserMergeRule[] | null) ?? [];

      // Validar conflictos: alias ya en otra regla, o canonical circular
      for (const alias of aliases) {
        for (const rule of existingRules) {
          const alreadyInRule = rule.aliases.some(
            (r) =>
              normalizeStr(r.nombre) === normalizeStr(alias.nombre) &&
              ((!r.email && !alias.email) ||
                (!!r.email && !!alias.email &&
                  normalizeStr(r.email) === normalizeStr(alias.email))),
          );
          if (alreadyInRule) {
            return reply.status(409).send({
              ok: false,
              error: `El alias "${alias.nombre}" ya pertenece a otra regla de merge`,
            });
          }

          // Canonical no puede ser alias de otra regla (merge circular) — por email
          if (
            canonicalEmail &&
            rule.aliases.some(
              (r) => r.email && normalizeStr(r.email) === normalizeStr(canonicalEmail),
            )
          ) {
            return reply.status(409).send({
              ok: false,
              error: `El canonical_email "${canonicalEmail}" ya es alias en otra regla — merge circular`,
            });
          }

          // Canonical no puede ser alias de otra regla (merge circular) — por nombre (cuando no hay email)
          if (
            !canonicalEmail &&
            rule.aliases.some(
              (r) => normalizeStr(r.nombre) === normalizeStr(canonicalNombre),
            )
          ) {
            return reply.status(409).send({
              ok: false,
              error: `El canonical_nombre "${canonicalNombre}" ya es alias en otra regla — merge circular`,
            });
          }
        }
      }

      // 3. Backfill histórico
      const aliasNombres = aliases.map((a) => a.nombre);
      const aliasEmails = aliases.map((a) => a.email).filter((e): e is string => !!e);

      const updatedLogs = await pgPool.query<{ count: string }>(
        `WITH updated AS (
           UPDATE log_llamadas
           SET nombre_closer = $1,
               closer_mail   = COALESCE($2, closer_mail)
           WHERE id_cuenta = $3
             AND (
               nombre_closer = ANY($4::text[])
               OR ($5::text[] <> '{}' AND closer_mail = ANY($5::text[]))
             )
           RETURNING 1
         ) SELECT COUNT(*)::text AS count FROM updated`,
        [canonicalNombre, canonicalEmail, idCuenta, aliasNombres, aliasEmails],
      );

      const updatedLlamadas = await pgPool.query<{ count: string }>(
        `WITH updated AS (
           UPDATE registros_de_llamada
           SET nombre_closer = $1,
               closer_mail   = COALESCE($2, closer_mail)
           WHERE id_cuenta = $3
             AND (
               nombre_closer = ANY($4::text[])
               OR ($5::text[] <> '{}' AND closer_mail = ANY($5::text[]))
             )
           RETURNING 1
         ) SELECT COUNT(*)::text AS count FROM updated`,
        [canonicalNombre, canonicalEmail, idCuenta, aliasNombres, aliasEmails],
      );

      const updatedAgendas = await pgPool.query<{ count: string }>(
        `WITH updated AS (
           UPDATE resumenes_diarios_agendas
           SET closer = $1
           WHERE id_cuenta = $2 AND closer = ANY($3::text[])
           RETURNING 1
         ) SELECT COUNT(*)::text AS count FROM updated`,
        [canonicalNombre, idCuenta, aliasNombres],
      );

      const totalMerged =
        Number(updatedLogs.rows[0]?.count ?? 0) +
        Number(updatedLlamadas.rows[0]?.count ?? 0) +
        Number(updatedAgendas.rows[0]?.count ?? 0);

      // 4. Agregar regla a cuentas.closer_merge_rules
      const newRule: CloserMergeRule = {
        canonical_email: canonicalEmail ?? null,
        canonical_nombre: canonicalNombre,
        aliases,
      };

      await drizzleDb
        .update(cuentas)
        .set({
          closer_merge_rules: sql`COALESCE(closer_merge_rules, '[]'::jsonb) || ${JSON.stringify([newRule])}::jsonb`,
        })
        .where(eq(cuentas.id_cuenta, idCuenta));

      // 5. Marcar suggestion como accepted
      await pgPool.query(
        `UPDATE closer_merge_suggestions SET status = 'accepted', resuelto_at = NOW() WHERE id = $1`,
        [id],
      );

      return reply.send({
        ok: true,
        merged: {
          canonical_nombre: canonicalNombre,
          canonical_email: canonicalEmail,
          records_updated: totalMerged,
          log_llamadas: Number(updatedLogs.rows[0]?.count ?? 0),
          registros_de_llamada: Number(updatedLlamadas.rows[0]?.count ?? 0),
          resumenes_diarios_agendas: Number(updatedAgendas.rows[0]?.count ?? 0),
        },
      });
    },
  );

  // ── POST /merge-suggestions/:id/reject ────────────────────────────────────
  app.post<{ Params: SuggestionParams }>(
    "/merge-suggestions/:id/reject",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer" } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: SuggestionParams }>, reply: FastifyReply) => {
      if (!request.apiKeyAuth) return reply.status(401).send({ ok: false, error: "Unauthorized" });
      const idCuenta = request.apiKeyAuth.idCuenta;
      const { id } = request.params;

      const check = await pgPool.query<{ id: number; status: string }>(
        `SELECT id, status FROM closer_merge_suggestions WHERE id = $1 AND id_cuenta = $2 LIMIT 1`,
        [id, idCuenta],
      );

      const row = check.rows[0];
      if (!row) {
        return reply.status(404).send({ ok: false, error: "Sugerencia no encontrada" });
      }
      if (row.status !== "pending") {
        return reply.status(409).send({ ok: false, error: `La sugerencia ya está ${row.status}` });
      }

      await pgPool.query(
        `UPDATE closer_merge_suggestions SET status = 'rejected', resuelto_at = NOW() WHERE id = $1`,
        [id],
      );

      return reply.send({ ok: true });
    },
  );

  // ── POST /detect-duplicates — trigger manual ──────────────────────────────
  app.post(
    "/detect-duplicates",
    {
      preHandler: [apiKeyAuthHook],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.apiKeyAuth) return reply.status(401).send({ ok: false, error: "Unauthorized" });
      const idCuenta = request.apiKeyAuth.idCuenta;

      try {
        const suggestionsCreated = await detectDuplicates(idCuenta);
        return reply.send({ ok: true, suggestions_created: suggestionsCreated });
      } catch (err) {
        console.error(`[detect-duplicates] Error cuenta ${idCuenta}:`, err);
        return reply.status(500).send({ ok: false, error: "Error al detectar duplicados" });
      }
    },
  );
}

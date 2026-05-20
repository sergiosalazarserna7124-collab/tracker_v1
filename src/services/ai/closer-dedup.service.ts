/**
 * AUT-272: Servicio de detección de closers duplicados.
 *
 * detectDuplicates(idCuenta) — llama a GPT-4o-mini para detectar nombres/emails
 *   similares en el equipo de ventas de una cuenta e inserta sugerencias.
 *
 * applyMergeRules(idCuenta, email, nombre) — aplica las reglas aceptadas para
 *   normalizar closers en tiempo de ingesta.
 */

import { generateObject, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { eq } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { db as pgPool } from "../../config/database.js";
import { cuentas } from "../../db/schema.js";
import { env } from "../../config/env.js";
import { trackApiUsage, TIPO_CONSUMO } from "./track-api-usage.service.js";

// ─── Tipos públicos ────────────────────────────────────────────────────────────

export interface CloserAlias {
  email?: string;
  nombre: string;
}

export interface DedupGrupo {
  grupo: CloserAlias[];
  canonical_nombre: string;
  canonical_email?: string;
}

export interface CloserMergeRule {
  canonical_email: string | null;
  canonical_nombre: string;
  aliases: CloserAlias[];
}

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface CloserCandidate {
  nombre: string;
  email?: string;
  conteo: number;
}

// ─── Modelo IA (BYOK) ─────────────────────────────────────────────────────────

const defaultProvider = createOpenAI({ apiKey: env.OPENAI_API_KEY });
const defaultModel = defaultProvider("gpt-4o-mini");

function resolveModel(openaiApiKey?: string | null): LanguageModel {
  if (openaiApiKey) {
    return createOpenAI({ apiKey: openaiApiKey })("gpt-4o-mini");
  }
  return defaultModel;
}

// ─── Normalización ────────────────────────────────────────────────────────────

function normalizeStr(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// ─── detectDuplicates ─────────────────────────────────────────────────────────

/**
 * Detecta closers duplicados para una cuenta usando GPT-4o-mini.
 * Inserta sugerencias en `closer_merge_suggestions`.
 * Retorna el número de sugerencias creadas.
 */
export async function detectDuplicates(idCuenta: number): Promise<number> {
  // 1. BYOK: leer openai_api_key de la cuenta
  const [cuenta] = await drizzleDb
    .select({ openai_api_key: cuentas.openai_api_key })
    .from(cuentas)
    .where(eq(cuentas.id_cuenta, idCuenta))
    .limit(1);

  // 2. Obtener closers únicos con conteos de las 3 fuentes
  const candidatesResult = await pgPool.query<{
    nombre: string;
    email: string | null;
    conteo: string;
  }>(
    `SELECT nombre_closer AS nombre, closer_mail AS email, COUNT(*)::text AS conteo
     FROM log_llamadas
     WHERE id_cuenta = $1 AND nombre_closer IS NOT NULL AND TRIM(nombre_closer) <> ''
     GROUP BY nombre_closer, closer_mail

     UNION ALL

     SELECT nombre_closer AS nombre, closer_mail AS email, COUNT(*)::text AS conteo
     FROM registros_de_llamada
     WHERE id_cuenta = $1::text AND nombre_closer IS NOT NULL AND TRIM(nombre_closer) <> ''
     GROUP BY nombre_closer, closer_mail

     UNION ALL

     SELECT closer AS nombre, NULL AS email, COUNT(*)::text AS conteo
     FROM resumenes_diarios_agendas
     WHERE id_cuenta = $1 AND closer IS NOT NULL AND TRIM(closer) <> ''
     GROUP BY closer`,
    [idCuenta],
  );

  // Agregar por clave normalizada (nombre + email)
  const candidateMap = new Map<string, CloserCandidate>();
  for (const row of candidatesResult.rows) {
    const key = `${normalizeStr(row.nombre)}|${row.email ? normalizeStr(row.email) : ""}`;
    const existing = candidateMap.get(key);
    if (existing) {
      existing.conteo += Number(row.conteo);
    } else {
      candidateMap.set(key, {
        nombre: row.nombre,
        email: row.email ?? undefined,
        conteo: Number(row.conteo),
      });
    }
  }

  const candidates = Array.from(candidateMap.values());

  // 3. Si < 2 closers únicos → skip
  if (candidates.length < 2) {
    return 0;
  }

  // 4. Anti-spam: skip si ya hay sugerencia pending creada hace < 7 días
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const recentCheck = await pgPool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM closer_merge_suggestions
     WHERE id_cuenta = $1 AND status = 'pending' AND created_at >= $2`,
    [idCuenta, sevenDaysAgo.toISOString()],
  );

  if (Number(recentCheck.rows[0]?.count ?? 0) > 0) {
    return 0;
  }

  // 5. Construir lista de candidatos y llamar a GPT-4o-mini
  const candidateList = candidates
    .map(
      (c) =>
        `- Nombre: "${c.nombre}"${c.email ? `, Email: "${c.email}"` : ""} (${c.conteo} registros)`,
    )
    .join("\n");

  const dedupSchema = jsonSchema<{ grupos: DedupGrupo[] }>({
    type: "object",
    properties: {
      grupos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            grupo: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  email: { type: "string" },
                  nombre: { type: "string" },
                },
                required: ["nombre"],
                additionalProperties: false,
              },
            },
            canonical_nombre: { type: "string" },
            canonical_email: { type: "string" },
          },
          required: ["grupo", "canonical_nombre"],
          additionalProperties: false,
        },
      },
    },
    required: ["grupos"],
    additionalProperties: false,
  });

  let aiResult;
  try {
    aiResult = await generateObject({
      model: resolveModel(cuenta?.openai_api_key),
      schema: dedupSchema,
      system:
        "Eres un asistente que detecta nombres/emails duplicados en equipos de ventas.",
      prompt: `Analiza esta lista de closers (asesores de ventas) e identifica posibles duplicados — personas que aparecen con nombres o emails ligeramente diferentes.

Lista de closers:
${candidateList}

Agrupa los que claramente son la misma persona. Solo agrupa si estás muy seguro. En caso de duda, no agrupes.

Para cada grupo de duplicados, indica:
- grupo: la lista completa de variantes encontradas
- canonical_nombre: el nombre canónico a usar (el más completo o más frecuente)
- canonical_email: el email canónico (si aplica)

Si no hay duplicados claros, retorna {"grupos": []}.`,
      temperature: 0,
    });
  } catch (err) {
    console.error(`[closer-dedup] Error GPT para cuenta ${idCuenta}:`, err);
    return 0;
  }

  void trackApiUsage(idCuenta, TIPO_CONSUMO.GPT4O_MINI, aiResult.usage.totalTokens ?? 0);

  const grupos = aiResult.object.grupos.filter((g) => g.grupo.length >= 2);
  if (grupos.length === 0) return 0;

  // 6. Insertar sugerencias (idempotente: skip si ya existe pending con mismo canonical)
  let inserted = 0;

  for (const grupo of grupos) {
    const dupCheck = await pgPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM closer_merge_suggestions
       WHERE id_cuenta = $1 AND status = 'pending'
         AND LOWER(TRIM(canonical_nombre)) = LOWER(TRIM($2))`,
      [idCuenta, grupo.canonical_nombre],
    );

    if (Number(dupCheck.rows[0]?.count ?? 0) > 0) continue;

    await pgPool.query(
      `INSERT INTO closer_merge_suggestions (id_cuenta, aliases, canonical_nombre, canonical_email)
       VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT DO NOTHING`,
      [
        idCuenta,
        JSON.stringify(grupo.grupo),
        grupo.canonical_nombre,
        grupo.canonical_email ?? null,
      ],
    );

    inserted++;
  }

  if (inserted > 0) {
    console.info(`[closer-dedup] Cuenta ${idCuenta}: ${inserted} sugerencias creadas`);
  }

  return inserted;
}

// ─── applyMergeRules ──────────────────────────────────────────────────────────

/**
 * Aplica las reglas de merge aceptadas para normalizar un closer en ingesta.
 * Compara (case-insensitive, sin acentos) contra los aliases de cada regla.
 * Si hay match, retorna el canonical; si no, retorna los valores originales.
 */
export async function applyMergeRules(
  idCuenta: number,
  closerEmail: string | null | undefined,
  closerNombre: string | null | undefined,
): Promise<{ email: string | null | undefined; nombre: string | null | undefined }> {
  if (!closerNombre && !closerEmail) {
    return { email: closerEmail, nombre: closerNombre };
  }

  const [cuenta] = await drizzleDb
    .select({ closer_merge_rules: cuentas.closer_merge_rules })
    .from(cuentas)
    .where(eq(cuentas.id_cuenta, idCuenta))
    .limit(1);

  const rules = cuenta?.closer_merge_rules as CloserMergeRule[] | null | undefined;
  if (!rules || !Array.isArray(rules) || rules.length === 0) {
    return { email: closerEmail, nombre: closerNombre };
  }

  const normEmail = closerEmail ? normalizeStr(closerEmail) : null;
  const normNombre = closerNombre ? normalizeStr(closerNombre) : null;

  for (const rule of rules) {
    for (const alias of rule.aliases) {
      const aliasNombre = normalizeStr(alias.nombre);
      const aliasEmail = alias.email ? normalizeStr(alias.email) : null;

      const emailMatch = normEmail && aliasEmail && normEmail === aliasEmail;
      const nombreMatch = normNombre && normNombre === aliasNombre;

      if (emailMatch || nombreMatch) {
        return {
          email: rule.canonical_email || closerEmail,
          nombre: rule.canonical_nombre,
        };
      }
    }
  }

  return { email: closerEmail, nombre: closerNombre };
}

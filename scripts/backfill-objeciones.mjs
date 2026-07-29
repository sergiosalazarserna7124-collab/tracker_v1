#!/usr/bin/env node
/**
 * Backfill: re-extract ia_objeciones for log_llamadas with transcripts.
 *
 * Targets calls that either:
 * - Have no ia_objeciones at all (missed by cron limits)
 * - Have ia_objeciones without respuesta_vendedor (pre-AUT-1893)
 *
 * Usage:
 *   node scripts/backfill-objeciones.mjs [--cuenta=33] [--days=30] [--dry-run] [--limit=100]
 */

import pg from "pg";
import OpenAI from "openai";

const args = process.argv.slice(2);
const getArg = (name) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=")[1] : undefined;
};
const dryRun = args.includes("--dry-run");

const CUENTA_FILTER = getArg("cuenta") ? parseInt(getArg("cuenta"), 10) : null;
const DAYS = parseInt(getArg("days") ?? "30", 10);
const LIMIT = parseInt(getArg("limit") ?? "200", 10);
const BATCH_DELAY_MS = 500;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const SYSTEM_PROMPT = `Eres un analizador experto en identificar EXCLUSIVAMENTE objeciones de venta que representan barreras reales para cerrar una venta inmediatamente.

CATEGORÍAS VÁLIDAS: PRECIO, AUTORIDAD, TIEMPO, CONFIANZA, NECESIDAD, COMPARACION, CAPACIDAD, GENERAL.

DEFINICIÓN ESTRICTA: Una objeción es una declaración EXPLÍCITA del prospecto que:
- Impide cerrar la venta EN ESTE MOMENTO
- Expresa una barrera ESPECÍFICA para comprar
- Se refiere directamente a ESTA oferta específica

FILTROS CRÍTICOS — Esto NUNCA es una objeción:
- Preguntas logísticas: "¿a qué hora abren?", "¿dónde quedan?"
- Coordinación de pago: "te pago a las 5", "dame los datos para pagar"
- Preguntas informativas: "¿cuánto cuesta?", "¿qué incluye?" (son consultas normales)
- Interrupciones, descripciones del negocio, conversación trivial

RESPUESTA DEL VENDEDOR: Para CADA objeción detectada, extrae la respuesta LITERAL del vendedor/asesor/closer a esa objeción.
- Busca las palabras EXACTAS que el vendedor dijo INMEDIATAMENTE DESPUÉS de la objeción del prospecto.
- NO parafrasees ni resumas — copia el texto VERBATIM tal cual aparece en la transcripción.
- Si el vendedor no respondió directamente a la objeción, usa "" (cadena vacía).
- Máximo 300 caracteres de la respuesta.

ALGORITMO: Solo extrae frases del PROSPECTO que respondan a "¿Por qué NO puedes o NO quieres comprar AHORA?".

Si no encuentras objeciones válidas, devuelve {"objeciones": []}.`;

async function extractObjections(transcript) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Transcript:\n${transcript.slice(0, 8000)}` },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return [];

  const parsed = JSON.parse(content);
  return Array.isArray(parsed.objeciones) ? parsed.objeciones : [];
}

async function main() {
  console.log(`[backfill-objeciones] Config: cuenta=${CUENTA_FILTER ?? "ALL"} days=${DAYS} limit=${LIMIT} dryRun=${dryRun}`);

  const cuentaClause = CUENTA_FILTER ? `AND id_cuenta = ${CUENTA_FILTER}` : "";

  // Find calls with transcripts that need objection extraction or re-extraction
  const { rows } = await pool.query(`
    SELECT id, id_cuenta, transcripcion, ia_objeciones
    FROM log_llamadas
    WHERE transcripcion IS NOT NULL
      AND transcripcion <> ''
      AND ts >= NOW() - INTERVAL '${DAYS} days'
      AND (
        ia_objeciones IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(ia_objeciones) = 'array' THEN ia_objeciones ELSE '[]'::jsonb END
          ) elem WHERE elem ? 'respuesta_vendedor'
        )
      )
      ${cuentaClause}
    ORDER BY ts DESC
    LIMIT ${LIMIT}
  `);

  console.log(`[backfill-objeciones] Found ${rows.length} calls to process`);

  let updated = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      if (dryRun) {
        console.log(`[dry-run] Would process id=${row.id} cuenta=${row.id_cuenta} transcript=${row.transcripcion.length}chars`);
        continue;
      }

      const objeciones = await extractObjections(row.transcripcion);

      await pool.query(
        `UPDATE log_llamadas SET ia_objeciones = $1::jsonb WHERE id = $2`,
        [JSON.stringify(objeciones), row.id],
      );

      updated++;
      const objCount = objeciones.length;
      console.log(`[backfill] id=${row.id} cuenta=${row.id_cuenta} objeciones=${objCount}`);

      // Rate limiting
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    } catch (err) {
      errors++;
      console.error(`[backfill] Error id=${row.id}:`, err.message);
    }
  }

  console.log(`[backfill-objeciones] Done: processed=${rows.length} updated=${updated} errors=${errors}`);
  await pool.end();
}

main().catch((err) => {
  console.error("[backfill-objeciones] Fatal:", err);
  process.exit(1);
});

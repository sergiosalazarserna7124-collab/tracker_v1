/**
 * Regression test: id_cuenta casts en mapa-tiempos queries.
 * AUT-2024 — el endpoint GET /api/data/mapa-tiempos llegó a prod sin casts
 * correctos, causando 9x HTTP 500 (error 42883: integer = text).
 *
 * Ejecutar: node --import tsx/esm --test src/tests/mapa-tiempos-casts.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const serviceSource = readFileSync(
  join(__dirname, "..", "services", "data", "mapa-tiempos.service.ts"),
  "utf-8",
);

/**
 * Column types in prod (verified via information_schema):
 *   registros_de_llamada.id_cuenta → varchar   → needs $1::text
 *   log_llamadas.id_cuenta         → integer   → needs $1::int
 *   webhook_events_log.id_cuenta   → integer   → needs $1::int
 */
const TABLE_EXPECTED_CAST: Array<{
  table: string;
  colType: "text" | "int";
}> = [
  { table: "registros_de_llamada", colType: "text" },
  { table: "log_llamadas", colType: "int" },
  { table: "webhook_events_log", colType: "int" },
];

function extractSqlBlocks(source: string): string[] {
  const blocks: string[] = [];
  const backtickRegex = /`([^`]*\bid_cuenta\b[^`]*)`/gs;
  let m: RegExpExecArray | null;
  while ((m = backtickRegex.exec(source)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

/**
 * For every WHERE / ON clause referencing `<alias>.id_cuenta = $<N>`,
 * ensure the param is cast to the correct type for that table.
 */
function findIdCuentaComparisons(
  sql: string,
): Array<{ alias: string; cast: string | null }> {
  const results: Array<{ alias: string; cast: string | null }> = [];
  const re = /(\w+)\.id_cuenta\s*=\s*\$(\d+)(?:::(\w+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    results.push({ alias: m[1], cast: m[3] ?? null });
  }
  return results;
}

/**
 * Resolve which table an alias points to by scanning FROM/JOIN clauses.
 */
function resolveAlias(sql: string, alias: string): string | null {
  const patterns = [
    new RegExp(`FROM\\s+(\\w+)\\s+${alias}\\b`, "i"),
    new RegExp(`JOIN\\s+(\\w+)\\s+${alias}\\b`, "i"),
    new RegExp(`FROM\\s+(${alias})\\b(?!\\s+\\w)`, "i"),
  ];
  for (const p of patterns) {
    const m = p.exec(sql);
    if (m) return m[1];
  }
  return null;
}

describe("mapa-tiempos id_cuenta cast regression (AUT-2024)", () => {
  const sqlBlocks = extractSqlBlocks(serviceSource);

  test("service source contains SQL blocks referencing id_cuenta", () => {
    assert.ok(
      sqlBlocks.length >= 2,
      `Expected >= 2 SQL blocks with id_cuenta, found ${sqlBlocks.length}`,
    );
  });

  for (const { table, colType } of TABLE_EXPECTED_CAST) {
    test(`all comparisons against ${table}.id_cuenta use ::${colType} cast`, () => {
      let foundAny = false;

      for (const sql of sqlBlocks) {
        const comparisons = findIdCuentaComparisons(sql);

        for (const { alias, cast } of comparisons) {
          const resolved = resolveAlias(sql, alias);
          if (resolved !== table) continue;

          foundAny = true;
          assert.equal(
            cast,
            colType,
            `${table} (alias "${alias}"): expected $N::${colType} but got ${cast ? `$N::${cast}` : "$N (no cast)"}`,
          );
        }
      }

      assert.ok(
        foundAny,
        `No id_cuenta comparison found for table ${table} — query may be missing or alias resolution failed`,
      );
    });
  }

  test("no uncast id_cuenta comparisons exist", () => {
    const uncast: string[] = [];

    for (const sql of sqlBlocks) {
      const comparisons = findIdCuentaComparisons(sql);
      for (const { alias, cast } of comparisons) {
        if (!cast) {
          uncast.push(`alias "${alias}" in SQL block`);
        }
      }
    }

    assert.equal(
      uncast.length,
      0,
      `Found uncast id_cuenta comparisons: ${uncast.join(", ")}`,
    );
  });

  test("totalRow count query also casts id_cuenta to ::text for registros_de_llamada", () => {
    const countBlocks = sqlBlocks.filter((s) =>
      /COUNT\s*\(\s*\*\s*\)/i.test(s) && /registros_de_llamada/i.test(s),
    );
    assert.ok(countBlocks.length > 0, "Expected a COUNT(*) query on registros_de_llamada");

    for (const sql of countBlocks) {
      const comparisons = findIdCuentaComparisons(sql);
      const regComp = comparisons.find((c) => {
        const resolved = resolveAlias(sql, c.alias);
        return resolved === "registros_de_llamada" || resolved === "r";
      });
      assert.ok(regComp, "COUNT query must compare id_cuenta");
      assert.equal(
        regComp.cast,
        "text",
        `COUNT query on registros_de_llamada should cast ::text, got ::${regComp.cast ?? "none"}`,
      );
    }
  });
});

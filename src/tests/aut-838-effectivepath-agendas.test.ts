/**
 * AUT-838: effectivePath must NOT overwrite PDTE agendas with phone call analysis.
 * Source-level regression guard — catches re-introduction of the removed pattern.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readService(name: string): string {
  return readFileSync(resolve(__dirname, `../services/webhooks/${name}`), "utf-8");
}

function extractEffectivePath(source: string): string {
  const start = source.indexOf("function effectivePath(");
  if (start === -1) return "";
  let depth = 0;
  let i = source.indexOf("{", start);
  const begin = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) break;
  }
  return source.slice(begin, i + 1);
}

describe("AUT-838: effectivePath must not touch agendas", () => {
  for (const file of ["ghl-calls.service.ts"]) {
    test(`${file} — effectivePath does not update agendas table`, () => {
      const body = extractEffectivePath(readService(file));
      assert.ok(body.length > 0, `Could not find effectivePath in ${file}`);
      assert.ok(
        !body.includes(".update(agendas)"),
        `${file}: effectivePath still contains .update(agendas) — phone calls must not overwrite PDTE agendas`,
      );
      assert.ok(
        !body.includes("updateAgenda"),
        `${file}: effectivePath still references updateAgenda label — the agenda-overwrite block was not fully removed`,
      );
    });

    test(`${file} — agendas schema import removed`, () => {
      const source = readService(file);
      const importLines = source.split("\n").filter((l) => l.startsWith("import") && l.includes("schema"));
      for (const line of importLines) {
        assert.ok(
          !line.includes("agendas"),
          `${file}: still imports 'agendas' from schema — should be removed after AUT-838`,
        );
      }
    });
  }
});

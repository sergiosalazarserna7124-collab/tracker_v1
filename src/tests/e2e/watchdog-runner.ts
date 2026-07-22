/**
 * Watchdog Runner — corre la suite E2E y produce un reporte estructurado.
 * Usado por la routine diaria de Paperclip para alertar a Juan si algo falla.
 *
 * Exit code 0 = todo verde, 1 = hay fallos.
 * stdout = JSON con resultados por caso.
 */

import { run } from "node:test";
import { spec } from "node:test/reporters";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
}

const results: TestResult[] = [];
let failed = 0;

const stream = run({
  files: [resolve(__dirname, "golden-cases.test.ts")],
  timeout: 120_000,
});

stream.on("test:pass", (event) => {
  results.push({
    name: event.name,
    passed: true,
    duration: event.details?.duration_ms ?? 0,
  });
});

stream.on("test:fail", (event) => {
  failed++;
  results.push({
    name: event.name,
    passed: false,
    duration: event.details?.duration_ms ?? 0,
    error:
      event.details?.error?.message ??
      event.details?.error?.toString() ??
      "unknown",
  });
});

stream.compose(spec()).pipe(process.stderr);

stream.on("end", () => {
  const report = {
    timestamp: new Date().toISOString(),
    total: results.length,
    passed: results.length - failed,
    failed,
    cases: results,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  if (failed > 0) {
    const failedNames = results
      .filter((r) => !r.passed)
      .map((r) => `- ${r.name}: ${r.error}`)
      .join("\n");
    process.stderr.write(
      `\n🔴 ${failed} golden case(s) FAILED:\n${failedNames}\n`,
    );
    process.exit(1);
  } else {
    process.stderr.write(
      `\n✅ All ${results.length} golden cases passed.\n`,
    );
    process.exit(0);
  }
});

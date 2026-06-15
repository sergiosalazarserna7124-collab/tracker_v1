import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../config/database.js";

const LOCK_ID = 839_274_613;
const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

// Tablas que existen si la BD ya fue migrada a mano (baseline check)
const BASELINE_PROBE = "cuentas";

async function ensureTrackingTable(client: import("pg").PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function seedBaseline(
  client: import("pg").PoolClient,
  files: string[],
): Promise<number> {
  const { rowCount } = await client.query("SELECT 1 FROM schema_migrations LIMIT 1");
  if ((rowCount ?? 0) > 0) return 0;

  // Solo sembramos si la BD ya tiene las tablas core (migradas a mano)
  const probe = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
    [BASELINE_PROBE],
  );
  if ((probe.rowCount ?? 0) === 0) return 0;

  const values = files
    .map((_, i) => `($${i + 1}, now())`)
    .join(", ");
  await client.query(
    `INSERT INTO schema_migrations (filename, applied_at) VALUES ${values} ON CONFLICT DO NOTHING`,
    files,
  );
  return files.length;
}

export async function runMigrations(): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = await db.connect();
  try {
    // Advisory lock — serializa instancias concurrentes en Cloud Run
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);

    await ensureTrackingTable(client);

    const seeded = await seedBaseline(client, files);
    if (seeded > 0) {
      console.log(`[migrate] baseline seed: ${seeded} migraciones existentes registradas`);
    }

    const { rows: applied } = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations",
    );
    const appliedSet = new Set(applied.map((r) => r.filename));
    const pending = files.filter((f) => !appliedSet.has(f));

    console.log(`[migrate] ${pending.length} pendientes de ${files.length} totales`);

    for (const file of pending) {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8");
      // Cada migración en su propia transacción con timeout defensivo
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '30s'");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        console.log(`[migrate] aplicada: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`[migrate] fallo en ${file}: ${err instanceof Error ? err.message : err}`);
      }
    }

    console.log(`[migrate] 0 pendientes — listo`);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    client.release();
  }
}

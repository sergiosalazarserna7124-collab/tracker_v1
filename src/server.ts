import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { db } from "./config/database.js";
import { runMigrations } from "./db/migrate.js";
import { startGhlCallsReconcileLoop } from "./services/cron/ghl-calls-reconcile.service.js";
import { startNoShowsLoop } from "./services/cron/no-shows-auto.service.js";

async function start() {
  await runMigrations();

  const app = await buildApp();

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received – shutting down`);
    await app.close();
    await db.end();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await app.listen({ port: Number(env.PORT), host: "0.0.0.0" });
    startGhlCallsReconcileLoop(Number(env.GHL_CALLS_RECONCILE_MIN));
    startNoShowsLoop(Number(env.NO_SHOWS_SWEEP_MIN));
  } catch (err) {
    app.log.fatal(err, "Failed to start server");
    process.exit(1);
  }
}

start();

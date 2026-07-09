import { Pool } from "pg";
import { env } from "./env.js";

export const db = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,

  max: 8,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,

  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

// Capturar errores de fondo en conexiones idle para que no crasheen el proceso.
// Cuando pg detecta que un socket fue cerrado por el servidor remoto, emite
// 'error' en el pool; sin este handler, Node lo trata como unhandled y mata la instancia.
db.on("error", (err) => {
  console.error("[DB Pool] Background error on idle client:", err.message);
});

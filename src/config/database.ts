import { Pool } from "pg";
import { env } from "./env.js";

export const db = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,

  // Cloud Run puede escalar a 0 y cada instancia levanta un pool propio.
  // max: 5 evita saturar el límite de conexiones del servidor de BD
  // cuando hay múltiples instancias corriendo en paralelo.
  max: 5,

  // Tiempo máximo para obtener una conexión libre del pool.
  // 2_000ms era demasiado corto para cold-starts en Cloud Run;
  // con 10_000ms damos margen suficiente.
  connectionTimeoutMillis: 10_000,

  // Cierra conexiones idle después de 30s para evitar acumular
  // conexiones muertas si el contenedor estuvo inactivo.
  idleTimeoutMillis: 30_000,

  // TCP keepalive: detecta conexiones rotas antes de intentar usarlas.
  // Crítico para Cloud Run donde el servidor de BD puede cerrar
  // silenciosamente conexiones idle que el pool aún cree vivas.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

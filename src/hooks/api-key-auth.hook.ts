import type { FastifyRequest, FastifyReply } from "fastify";
import { eq, and } from "drizzle-orm";
import { drizzleDb } from "../config/drizzle.js";
import { apiKeysCuenta } from "../db/schema.js";

declare module "fastify" {
  interface FastifyRequest {
    apiKeyAuth?: { idCuenta: number };
  }
}

export async function apiKeyAuthHook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers["authorization"];
  const apiKeyHeader = request.headers["x-api-key"];

  const raw = (typeof authHeader === "string" ? authHeader : undefined)
    ?? (typeof apiKeyHeader === "string" ? apiKeyHeader : undefined);

  if (!raw) {
    return reply
      .status(401)
      .send({ success: false, error: "Missing API key" });
  }

  const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;

  if (!token) {
    return reply
      .status(401)
      .send({ success: false, error: "Empty API key token" });
  }

  const [row] = await drizzleDb
    .select({ id_cuenta: apiKeysCuenta.id_cuenta })
    .from(apiKeysCuenta)
    .where(and(eq(apiKeysCuenta.token, token), eq(apiKeysCuenta.activa, true)))
    .limit(1);

  if (!row) {
    return reply
      .status(401)
      .send({ success: false, error: "Invalid or inactive API key" });
  }

  request.apiKeyAuth = { idCuenta: row.id_cuenta };
}

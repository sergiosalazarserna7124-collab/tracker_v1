import type { FastifyInstance } from "fastify";

export async function healthRoute(app: FastifyInstance) {
  app.get("/health", async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      build: "AUT-690-diagnostic-20260606",
    };
  });
}

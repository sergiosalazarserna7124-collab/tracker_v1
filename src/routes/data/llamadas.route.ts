import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import { handleGetLlamadas, type LlamadasQuerystring } from "../../controllers/data/llamadas.controller.js";

export async function dataLlamadasRoute(app: FastifyInstance) {
  app.get<{ Querystring: LlamadasQuerystring }>(
    "/llamadas",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        querystring: {
          type: "object",
          required: ["id_cuenta"],
          properties: {
            id_cuenta: { type: "integer" },
            desde: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            hasta: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          },
        },
      },
    },
    handleGetLlamadas,
  );
}

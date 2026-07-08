import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import { handleGetVideollamadas, type VideollamadasQuerystring } from "../../controllers/data/videollamadas.controller.js";

export async function dataVideollamadasRoute(app: FastifyInstance) {
  app.get<{ Querystring: VideollamadasQuerystring }>(
    "/videollamadas",
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
    handleGetVideollamadas,
  );
}

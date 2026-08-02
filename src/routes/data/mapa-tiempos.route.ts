import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import {
  handleGetMapaTiempos,
  type MapaTiemposQuerystring,
} from "../../controllers/data/mapa-tiempos.controller.js";

export async function mapaTiemposRoute(app: FastifyInstance) {
  app.get<{ Querystring: MapaTiemposQuerystring }>(
    "/mapa-tiempos",
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
            asesor: { type: "string" },
            lead: { type: "string", pattern: "^\\d+$" },
          },
        },
      },
    },
    handleGetMapaTiempos,
  );
}

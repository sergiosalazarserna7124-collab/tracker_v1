import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import {
  handleGetObjecionesDetalle,
  type ObjecionesDetalleQuerystring,
} from "../../controllers/data/objeciones-detalle.controller.js";

export async function objecionesDetalleRoute(app: FastifyInstance) {
  app.get<{ Querystring: ObjecionesDetalleQuerystring }>(
    "/objeciones-detalle",
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
            categoria: { type: "string" },
          },
        },
      },
    },
    handleGetObjecionesDetalle,
  );
}

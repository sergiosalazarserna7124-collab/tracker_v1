import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import {
  handleGetEtiquetasDescarte,
  handlePutEtiquetasDescarte,
} from "../../controllers/data/etiquetas-descarte.controller.js";

interface CuentaParams {
  id: string;
}

export async function etiquetasDescarteRoute(app: FastifyInstance) {
  app.get<{ Params: CuentaParams }>(
    "/cuentas/:id/etiquetas-descarte",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer" } },
        },
      },
    },
    handleGetEtiquetasDescarte,
  );

  app.put<{ Params: CuentaParams }>(
    "/cuentas/:id/etiquetas-descarte",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer" } },
        },
        body: {
          oneOf: [
            {
              type: "array",
              items: { type: "string", minLength: 1 },
              minItems: 1,
            },
            { type: "null" },
          ],
        },
      },
    },
    handlePutEtiquetasDescarte,
  );
}

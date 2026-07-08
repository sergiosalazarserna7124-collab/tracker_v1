import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import {
  handleGetCanalesActivos,
  handlePatchCanalesActivos,
  type CuentaParams,
} from "../../controllers/data/canales-activos.controller.js";

const paramsSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "integer" },
  },
} as const;

const canalesBodySchema = {
  oneOf: [
    {
      type: "object",
      required: ["chats", "llamadas", "videollamadas"],
      properties: {
        chats: { type: "boolean" },
        llamadas: { type: "boolean" },
        videollamadas: { type: "boolean" },
      },
      additionalProperties: false,
    },
    { type: "null" },
  ],
} as const;

export async function canalesActivosRoute(app: FastifyInstance) {
  app.get<{ Params: CuentaParams }>(
    "/cuentas/:id/canales-activos",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        params: paramsSchema,
      },
    },
    handleGetCanalesActivos,
  );

  app.patch<{ Params: CuentaParams }>(
    "/cuentas/:id/canales-activos",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        params: paramsSchema,
        body: canalesBodySchema,
      },
    },
    handlePatchCanalesActivos,
  );
}

/**
 * Rutas para gestionar criterios_calificacion de una cuenta.
 *
 * GET  /api/cuentas/:id/criterios-calificacion
 * PATCH /api/cuentas/:id/criterios-calificacion
 *
 * AUT-413: criterios de calificación configurables por cuenta.
 */

import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import {
  handleGetCriteriosCalificacion,
  handlePatchCriteriosCalificacion,
  type CuentaParams,
} from "../../controllers/data/criterios-calificacion.controller.js";

const paramsSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "integer" },
  },
} as const;

const criteriosCanalSchema = {
  type: "object",
  required: ["categorias_calificadas"],
  properties: {
    categorias_calificadas: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
    umbral_minimo: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
} as const;

const criteriosBodySchema = {
  oneOf: [
    {
      type: "object",
      required: ["categorias_calificadas"],
      properties: {
        categorias_calificadas: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
        },
        umbral_minimo: { type: "integer", minimum: 1 },
        canales: {
          type: "object",
          properties: {
            chats: criteriosCanalSchema,
            llamadas: criteriosCanalSchema,
            videollamadas: criteriosCanalSchema,
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    { type: "null" },
  ],
} as const;

export async function criteriosCalificacionRoute(app: FastifyInstance) {
  app.get<{ Params: CuentaParams }>(
    "/cuentas/:id/criterios-calificacion",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        params: paramsSchema,
      },
    },
    handleGetCriteriosCalificacion,
  );

  app.patch<{ Params: CuentaParams }>(
    "/cuentas/:id/criterios-calificacion",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        params: paramsSchema,
        body: criteriosBodySchema,
      },
    },
    handlePatchCriteriosCalificacion,
  );
}

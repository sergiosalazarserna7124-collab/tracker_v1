import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import {
  handleGetGuiones,
  handleGetGuionByCategoria,
  handleUpsertGuion,
  handleDeleteGuion,
  type CuentaParams,
  type CategoriaParams,
} from "../../controllers/data/coach-guion.controller.js";

const cuentaParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "integer" } },
} as const;

const categoriaParamsSchema = {
  type: "object",
  required: ["id", "categoriaId"],
  properties: {
    id: { type: "integer" },
    categoriaId: { type: "string", minLength: 1 },
  },
} as const;

const seccionSchema = {
  type: "object",
  required: ["id", "nombre", "criterio", "tipo"],
  properties: {
    id: { type: "string", minLength: 1 },
    nombre: { type: "string", minLength: 1 },
    criterio: { type: "string", minLength: 1 },
    tipo: { type: "string", enum: ["must_have", "deseable"] },
  },
  additionalProperties: false,
} as const;

const upsertBodySchema = {
  type: "object",
  required: ["categoria_llamada_id", "secciones"],
  properties: {
    categoria_llamada_id: { type: "string", minLength: 1 },
    secciones: {
      type: "array",
      items: seccionSchema,
      minItems: 1,
    },
    umbral: { type: "integer", minimum: 0, maximum: 100 },
  },
  additionalProperties: false,
} as const;

export async function coachGuionRoute(app: FastifyInstance) {
  app.get<{ Params: CuentaParams }>(
    "/cuentas/:id/coach/guiones",
    {
      preHandler: [apiKeyAuthHook],
      schema: { params: cuentaParamsSchema },
    },
    handleGetGuiones,
  );

  app.get<{ Params: CategoriaParams }>(
    "/cuentas/:id/coach/guiones/:categoriaId",
    {
      preHandler: [apiKeyAuthHook],
      schema: { params: categoriaParamsSchema },
    },
    handleGetGuionByCategoria,
  );

  app.route<{ Params: CuentaParams }>({
    method: "PUT",
    url: "/cuentas/:id/coach/guiones",
    preHandler: [apiKeyAuthHook],
    schema: {
      params: cuentaParamsSchema,
      body: upsertBodySchema,
    },
    handler: handleUpsertGuion,
  });

  app.delete<{ Params: CategoriaParams }>(
    "/cuentas/:id/coach/guiones/:categoriaId",
    {
      preHandler: [apiKeyAuthHook],
      schema: { params: categoriaParamsSchema },
    },
    handleDeleteGuion,
  );
}

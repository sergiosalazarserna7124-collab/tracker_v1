import type { FastifyInstance } from "fastify";
import {
  ExternalDataParams,
  ExternalDataBody,
  type ExternalDataParamsType,
  type ExternalDataBodyType,
} from "../../schemas/webhooks/external-data.schema.js";
import { handleExternalData } from "../../controllers/webhooks/external-data.controller.js";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";

export async function externalDataRoute(app: FastifyInstance) {
  app.post<{ Params: ExternalDataParamsType; Body: ExternalDataBodyType }>(
    "/external-data/:locationid",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        params: ExternalDataParams,
        body: ExternalDataBody,
      },
    },
    handleExternalData,
  );
}

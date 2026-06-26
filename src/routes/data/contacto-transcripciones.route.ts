import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import { handleGetTranscripciones } from "../../controllers/data/contacto-transcripciones.controller.js";

interface TranscripcionesParams {
  idClienteInterno: string;
}

interface TranscripcionesQuery {
  desde?: string;
  hasta?: string;
  tipo?: string;
}

export async function contactoTranscripcionesRoute(app: FastifyInstance) {
  app.get<{ Params: TranscripcionesParams; Querystring: TranscripcionesQuery }>(
    "/contacto/:idClienteInterno/transcripciones",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        params: {
          type: "object",
          required: ["idClienteInterno"],
          properties: {
            idClienteInterno: { type: "string" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            desde: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            hasta: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            tipo: { type: "string", pattern: "^(chat|llamada|videollamada)(,(chat|llamada|videollamada))*$" },
          },
        },
      },
    },
    handleGetTranscripciones,
  );
}

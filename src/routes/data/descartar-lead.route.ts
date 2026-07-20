import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import { handleDescartarLead } from "../../controllers/data/descartar-lead.controller.js";

interface DescartarBody {
  id_cuenta: number;
  contact_ids: string[];
  descartar: boolean;
}

export async function descartarLeadRoute(app: FastifyInstance) {
  app.post<{ Body: DescartarBody }>(
    "/leads/descartar",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        body: {
          type: "object",
          required: ["id_cuenta", "contact_ids", "descartar"],
          properties: {
            id_cuenta: { type: "integer" },
            contact_ids: {
              type: "array",
              items: { type: "string", minLength: 1 },
              minItems: 1,
              maxItems: 500,
            },
            descartar: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
    },
    handleDescartarLead,
  );
}

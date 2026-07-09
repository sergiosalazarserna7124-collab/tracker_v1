import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import { handleBulkTag } from "../../controllers/data/bulk-tag.controller.js";
import type { BulkTagRequest } from "../../services/data/bulk-tag.service.js";

export async function bulkTagRoute(app: FastifyInstance) {
  app.post<{ Body: BulkTagRequest }>(
    "/leads/bulk-tag",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        body: {
          type: "object",
          required: ["id_cuenta", "contactIds", "operation"],
          properties: {
            id_cuenta: { type: "integer" },
            contactIds: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 500,
            },
            operation: { type: "string", enum: ["add", "remove"] },
            tags: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            customField: {
              type: "object",
              required: ["key", "value"],
              properties: {
                key: { type: "string", minLength: 1 },
                value: { type: "string" },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
    },
    handleBulkTag,
  );
}

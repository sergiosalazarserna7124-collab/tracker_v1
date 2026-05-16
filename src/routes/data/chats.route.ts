import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import { handleGetChats, type ChatsQuerystring } from "../../controllers/data/chats.controller.js";

export async function dataChatsRoute(app: FastifyInstance) {
  app.get<{ Querystring: ChatsQuerystring }>(
    "/chats",
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
          },
        },
      },
    },
    handleGetChats,
  );
}

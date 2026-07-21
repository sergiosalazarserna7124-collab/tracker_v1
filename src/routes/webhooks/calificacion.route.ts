import type { FastifyInstance } from "fastify";
import { handleCalificacionWebhook } from "../../controllers/webhooks/calificacion.controller.js";

interface CalificacionParams {
  locationid: string;
}

interface CalificacionBody {
  contactId: string;
  accion: "calificado" | "descartado";
}

export async function calificacionWebhookRoute(app: FastifyInstance) {
  app.post<{ Params: CalificacionParams; Body: CalificacionBody }>(
    "/calificacion/:locationid",
    {
      schema: {
        params: {
          type: "object",
          required: ["locationid"],
          properties: {
            locationid: { type: "string", minLength: 1 },
          },
        },
        body: {
          type: "object",
          required: ["contactId", "accion"],
          properties: {
            contactId: { type: "string", minLength: 1 },
            accion: { type: "string", enum: ["calificado", "descartado"] },
          },
          additionalProperties: true,
        },
      },
    },
    handleCalificacionWebhook,
  );
}

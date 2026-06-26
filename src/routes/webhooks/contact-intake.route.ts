import type { FastifyInstance } from "fastify";
import {
  ContactIntakeBody,
  type ContactIntakeBodyType,
} from "../../schemas/webhooks/contact-intake.schema.js";
import { handleContactIntake } from "../../controllers/webhooks/contact-intake.controller.js";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";

export async function contactIntakeRoute(app: FastifyInstance) {
  app.post<{ Body: ContactIntakeBodyType }>(
    "/contact-intake",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        body: ContactIntakeBody,
      },
    },
    handleContactIntake,
  );
}

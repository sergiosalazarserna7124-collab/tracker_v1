import type { FastifyInstance } from "fastify";
import { TwilioWebhookBody } from "../../schemas/webhooks/twilio.schema.js";
import {
  handleTwilioWebhook,
  handleNoAnswerCall,
  handleEffectiveCall,
} from "../../controllers/webhooks/twilio.controller.js";

export async function twilioWebhookRoute(app: FastifyInstance) {
  // Llamada pendiente: crea registro con estado "pdte"
  app.post(
    "/twilio",
    { schema: { body: TwilioWebhookBody } },
    handleTwilioWebhook,
  );

  // Llamada no contestada: busca registro existente → actualiza o crea con estado "seguimiento"
  app.post(
    "/twilio/no-answer",
    { schema: { body: TwilioWebhookBody } },
    handleNoAnswerCall,
  );

  // Llamada efectiva: Twilio pipeline → Whisper → IA → DB + GHL tag + nota
  app.post(
    "/twilio/effective",
    { schema: { body: TwilioWebhookBody } },
    handleEffectiveCall,
  );
}

import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  TwilioWebhookPayload,
  TwilioEventBody,
} from "../../schemas/webhooks/twilio.schema.js";
import {
  processTwilioWebhook,
  processNoAnswerCall,
  processEffectiveCall,
} from "../../services/webhooks/twilio.service.js";
import { extractWebhookBody } from "../../utils/payload.utils.js";

// ─── POST /webhooks/twilio ────────────────────────────────────────────────────
// Llamada pendiente: inserta registro con estado "pdte"

export async function handleTwilioWebhook(
  request: FastifyRequest<{ Body: TwilioWebhookPayload }>,
  reply: FastifyReply,
): Promise<void> {
  const eventBody = extractWebhookBody<TwilioEventBody>(request.body);

  if (!eventBody) {
    return reply.status(400).send({
      success: false,
      message: "Missing or invalid call event payload",
    });
  }

  const result = await processTwilioWebhook(eventBody);

  if (!result.success) {
    return reply.status(422).send({
      success: false,
      message: result.error ?? "Failed to process call event",
    });
  }

  return reply.status(200).send({
    success: true,
    message: "Call event registered",
    data: result.data,
  });
}

// ─── POST /webhooks/twilio/no-answer ─────────────────────────────────────────
// Llamada no contestada: actualiza registro existente o crea uno nuevo,
// luego aplica tag "no_contestallamadaautoia" en GHL.

export async function handleNoAnswerCall(
  request: FastifyRequest<{ Body: TwilioWebhookPayload }>,
  reply: FastifyReply,
): Promise<void> {
  const eventBody = extractWebhookBody<TwilioEventBody>(request.body);

  if (!eventBody) {
    return reply.status(400).send({
      success: false,
      message: "Missing or invalid no-answer event payload",
    });
  }

  const result = await processNoAnswerCall(eventBody);

  if (!result.success) {
    return reply.status(422).send({
      success: false,
      message: result.error ?? "Failed to process no-answer event",
    });
  }

  return reply.status(200).send({
    success: true,
    message: "No-answer call event processed",
    data: result.data,
  });
}

// ─── POST /webhooks/twilio/effective ──────────────────────────────────────────
// Llamada efectiva: responde 200 de inmediato y procesa en segundo plano.
// El pipeline (Twilio → Whisper → IA → DB → GHL) puede tardar varios segundos;
// procesarlo de forma asíncrona evita timeouts en el lado del llamante.

export async function handleEffectiveCall(
  request: FastifyRequest<{ Body: TwilioWebhookPayload }>,
  reply: FastifyReply,
): Promise<void> {
  const eventBody = extractWebhookBody<TwilioEventBody>(request.body);

  if (!eventBody) {
    return reply.status(400).send({
      success: false,
      message: "Missing or invalid effective call event payload",
    });
  }

  processEffectiveCall(eventBody).catch((err: unknown) => {
    request.log.error(
      { err },
      "[Effective] Error no capturado en processEffectiveCall",
    );
  });

  return reply.status(200).send({
    success: true,
    message: "Effective call event received and processing",
  });
}

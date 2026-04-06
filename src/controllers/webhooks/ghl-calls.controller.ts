import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  GhlCallWebhookPayload,
  GhlCallEventBody,
} from "../../schemas/webhooks/ghl-calls.schema.js";
import {
  processGhlCallPending,
  processGhlCallNoAnswer,
  processGhlCallEffective,
} from "../../services/webhooks/ghl-calls.service.js";
import { extractWebhookBody } from "../../utils/payload.utils.js";

// ─── POST /webhooks/ghl/calls/pending ────────────────────────────────────────
// Nueva llamada pendiente: crea registro con estado "pdte"

export async function handleGhlCallPending(
  request: FastifyRequest<{ Body: GhlCallWebhookPayload }>,
  reply: FastifyReply,
): Promise<void> {
  const body = extractWebhookBody<GhlCallEventBody>(request.body);
  if (!body) {
    return reply.status(400).send({ success: false, message: "Missing or invalid GHL call payload" });
  }

  const result = await processGhlCallPending(body);
  if (!result.success) {
    return reply.status(422).send({ success: false, message: result.error ?? "Failed to process GHL call pending" });
  }
  return reply.status(200).send({ success: true, message: "GHL call pending registered", data: result.data });
}

// ─── POST /webhooks/ghl/calls/no-answer ──────────────────────────────────────
// Llamada no contestada: busca registro existente → actualiza o crea en "seguimiento"

export async function handleGhlCallNoAnswer(
  request: FastifyRequest<{ Body: GhlCallWebhookPayload }>,
  reply: FastifyReply,
): Promise<void> {
  const body = extractWebhookBody<GhlCallEventBody>(request.body);
  if (!body) {
    return reply.status(400).send({ success: false, message: "Missing or invalid GHL no-answer payload" });
  }

  const result = await processGhlCallNoAnswer(body);
  if (!result.success) {
    return reply.status(422).send({ success: false, message: result.error ?? "Failed to process GHL no-answer" });
  }
  return reply.status(200).send({ success: true, message: "GHL no-answer call processed", data: result.data });
}

// ─── POST /webhooks/ghl/calls/effective ──────────────────────────────────────
// Llamada efectiva: transcript → IA → DB + GHL tag + nota
// Responde 200 de inmediato y procesa en segundo plano para evitar timeouts.

export async function handleGhlCallEffective(
  request: FastifyRequest<{ Body: GhlCallWebhookPayload }>,
  reply: FastifyReply,
): Promise<void> {
  const body = extractWebhookBody<GhlCallEventBody>(request.body);
  if (!body) {
    return reply.status(400).send({ success: false, message: "Missing or invalid GHL effective call payload" });
  }

  // Procesar async: el pipeline IA puede tardar varios segundos
  processGhlCallEffective(body).catch((err: unknown) => {
    request.log.error({ err }, "[GhlCalls/Effective] Error no capturado en processGhlCallEffective");
  });

  return reply.status(200).send({
    success: true,
    message: "GHL effective call received and processing",
  });
}

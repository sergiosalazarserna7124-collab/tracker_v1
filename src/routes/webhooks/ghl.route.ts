import type { FastifyInstance } from "fastify";
import { GhlWebhookBody } from "../../schemas/webhooks/ghl.schema.js";
import { handleGhlWebhook } from "../../controllers/webhooks/ghl.controller.js";
import { GhlCallWebhookBody } from "../../schemas/webhooks/ghl-calls.schema.js";
import {
  handleGhlCallPending,
  handleGhlCallNoAnswer,
  handleGhlCallEffective,
} from "../../controllers/webhooks/ghl-calls.controller.js";

export async function ghlWebhookRoute(app: FastifyInstance) {
  // ── Citas / agendas (existente) ────────────────────────────────────────────
  app.post(
    "/ghl",
    { schema: { body: GhlWebhookBody } },
    handleGhlWebhook,
  );

  // ── Llamadas GHL (nuevo) ───────────────────────────────────────────────────
  // Cuentas con fuente_llamadas = "ghl" usan estos endpoints en lugar de /twilio/*

  // Nueva llamada: crea registro con estado "pdte"
  app.post(
    "/ghl/calls/pending",
    { schema: { body: GhlCallWebhookBody } },
    handleGhlCallPending,
  );

  // Llamada no contestada: actualiza/crea en estado "seguimiento"
  app.post(
    "/ghl/calls/no-answer",
    { schema: { body: GhlCallWebhookBody } },
    handleGhlCallNoAnswer,
  );

  // Llamada efectiva: transcript → IA → DB + tags GHL
  app.post(
    "/ghl/calls/effective",
    { schema: { body: GhlCallWebhookBody } },
    handleGhlCallEffective,
  );
}

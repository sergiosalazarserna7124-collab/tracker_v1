import type { FastifyInstance } from "fastify";

// ── Handlers + esquemas reutilizados (mismos que /webhooks/*) ────────────────
import { FathomWebhookBody, FathomParams } from "../../schemas/webhooks/fathom.schema.js";
import { handleFathomWebhook } from "../../controllers/webhooks/fathom.controller.js";

import { GhlWebhookBody } from "../../schemas/webhooks/ghl.schema.js";
import { handleGhlWebhook } from "../../controllers/webhooks/ghl.controller.js";
import { GhlCallWebhookBody } from "../../schemas/webhooks/ghl-calls.schema.js";
import {
  handleGhlCallPending,
  handleGhlCallNoAnswer,
  handleGhlCallEffective,
} from "../../controllers/webhooks/ghl-calls.controller.js";

import { ChatWebhookBodySchema } from "../../schemas/webhooks/chat.schema.js";
import { handleChatWebhook } from "../../controllers/webhooks/chat.controller.js";

import {
  MetricasWebhookParams,
  type MetricasWebhookParamsType,
  type MetricasWebhookBodyType,
} from "../../schemas/webhooks/metricas-webhook.schema.js";
import { handleMetricasWebhook } from "../../controllers/webhooks/metricas-webhook.controller.js";

import {
  ExternalDataParams,
  ExternalDataBody,
  type ExternalDataParamsType,
  type ExternalDataBodyType,
} from "../../schemas/webhooks/external-data.schema.js";
import { handleExternalData } from "../../controllers/webhooks/external-data.controller.js";

import {
  ContactIntakeBody,
  type ContactIntakeBodyType,
} from "../../schemas/webhooks/contact-intake.schema.js";
import { handleContactIntake } from "../../controllers/webhooks/contact-intake.controller.js";

import { AsistenciaWebhookBody, AsistenciaParams } from "../../schemas/webhooks/asistencia.schema.js";
import { handleAsistenciaWebhook } from "../../controllers/webhooks/asistencia.controller.js";

import { handleCalificacionWebhook } from "../../controllers/webhooks/calificacion.controller.js";

import { ReasignacionWebhookBody } from "../../schemas/webhooks/reasignacion.schema.js";
import { handleReasignacion } from "../../controllers/webhooks/reasignacion.controller.js";

import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";

interface CalificacionParams {
  locationid: string;
}
interface CalificacionBody {
  contactId: string;
  accion: "calificado" | "descartado";
}

/**
 * Capa "LeadMaster" (LM) — rutas branded bajo /lm/webhook/{tipo}.
 * Cada endpoint apunta al MISMO handler que su equivalente en /webhooks/*,
 * para que las URLs entregadas a clientes lleven tu marca. La cuenta se
 * identifica desde el payload (location_id / id_cuenta); si no matchea una
 * cuenta, el evento cae en `eventos_huerfanos` (no se procesa data ajena).
 *
 *   /lm/webhook/videollamada/:id_cuenta   → Fathom
 *   /lm/webhook/cita                       → GHL citas
 *   /lm/webhook/llamada/pending|no-answer|effective → GHL llamadas
 *   /lm/webhook/chat                       → chats
 *   /lm/webhook/metricas/:locationid       → métricas
 *   /lm/webhook/datos-externos/:locationid → KPIs externos (requiere API key)
 *   /lm/webhook/contacto                   → alta de contacto (requiere API key)
 *   /lm/webhook/asistencia/:id_cuenta      → asistencia
 *   /lm/webhook/calificacion/:locationid   → calificación
 *   /lm/webhook/reasignacion               → reasignación
 */
export async function lmWebhookRoute(app: FastifyInstance) {
  // Videollamadas (Fathom)
  app.post(
    "/webhook/videollamada/:id_cuenta",
    {
      bodyLimit: 10 * 1024 * 1024,
      schema: { params: FathomParams, body: FathomWebhookBody },
    },
    handleFathomWebhook,
  );

  // Citas (GHL)
  app.post("/webhook/cita", { schema: { body: GhlWebhookBody } }, handleGhlWebhook);

  // Llamadas (GHL)
  app.post("/webhook/llamada/pending", { schema: { body: GhlCallWebhookBody } }, handleGhlCallPending);
  app.post("/webhook/llamada/no-answer", { schema: { body: GhlCallWebhookBody } }, handleGhlCallNoAnswer);
  app.post("/webhook/llamada/effective", { schema: { body: GhlCallWebhookBody } }, handleGhlCallEffective);

  // Chats
  app.post("/webhook/chat", { schema: { body: ChatWebhookBodySchema } }, handleChatWebhook);

  // Métricas
  app.post<{ Params: MetricasWebhookParamsType; Body: MetricasWebhookBodyType }>(
    "/webhook/metricas/:locationid",
    { schema: { params: MetricasWebhookParams } },
    handleMetricasWebhook,
  );

  // Datos externos (requiere API key)
  app.post<{ Params: ExternalDataParamsType; Body: ExternalDataBodyType }>(
    "/webhook/datos-externos/:locationid",
    {
      preHandler: [apiKeyAuthHook],
      schema: { params: ExternalDataParams, body: ExternalDataBody },
    },
    handleExternalData,
  );

  // Alta de contacto (requiere API key)
  app.post<{ Body: ContactIntakeBodyType }>(
    "/webhook/contacto",
    { preHandler: [apiKeyAuthHook], schema: { body: ContactIntakeBody } },
    handleContactIntake,
  );

  // Asistencia
  app.post(
    "/webhook/asistencia/:id_cuenta",
    { schema: { params: AsistenciaParams, body: AsistenciaWebhookBody } },
    handleAsistenciaWebhook,
  );

  // Calificación
  app.post<{ Params: CalificacionParams; Body: CalificacionBody }>(
    "/webhook/calificacion/:locationid",
    {
      schema: {
        params: {
          type: "object",
          required: ["locationid"],
          properties: { locationid: { type: "string", minLength: 1 } },
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

  // Reasignación
  app.post("/webhook/reasignacion", { schema: { body: ReasignacionWebhookBody } }, handleReasignacion);
}

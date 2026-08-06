import Fastify from "fastify";
import { env } from "./config/env.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { healthRoute } from "./routes/health.route.js";
import { fathomWebhookRoute } from "./routes/webhooks/fathom.route.js";
import { ghlWebhookRoute } from "./routes/webhooks/ghl.route.js";
import { cronDailyTasksRoute } from "./routes/cron/daily-tasks.route.js";
import { cronSincronizarAdsRoute } from "./routes/cron/sincronizar-ads.route.js";
import { cronDetectDuplicatesClosersRoute } from "./routes/cron/detect-duplicates-closers.route.js";
import { cronSpeedToLeadAlertsRoute } from "./routes/cron/speed-to-lead-alerts.route.js";
import { cronSpeedToLeadChatAlertsRoute } from "./routes/cron/speed-to-lead-chat-alerts.route.js";
import { cronWebhookRecoveryRoute } from "./routes/cron/webhook-recovery.route.js";
import { cronBatchAnalysisRoute } from "./routes/cron/batch-analysis.route.js";
import { cronChatSinResponderTagsRoute } from "./routes/cron/chat-sin-responder-tags.route.js";
import { cronGeminiBackfillRoute } from "./routes/cron/gemini-backfill.route.js";
import { externalDataRoute } from "./routes/webhooks/external-data.route.js";
import { orphanRoute } from "./routes/webhooks/orphan.route.js";
import { reasignacionRoute } from "./routes/webhooks/reasignacion.route.js";
import { videoRecoveryRoute } from "./routes/quick-triggers/video-recovery.route.js";
import { chatRecoveryRoute } from "./routes/quick-triggers/chat-recovery.route.js";
import { reprocessReglasRoute } from "./routes/quick-triggers/reprocess-reglas.route.js";
import { backfillMetricasReRoute } from "./routes/quick-triggers/backfill-metricas-re.route.js";
import { chatBackfillRoute } from "./routes/quick-triggers/chat-backfill.route.js";
import { chatWebhookRoute } from "./routes/webhooks/chat.route.js";
import { vozWebhookRoute } from "./routes/webhooks/voz.route.js";
import { ghlCallbackRoute } from "./routes/oauth/ghl-callback.route.js";
import { dataChatsRoute } from "./routes/data/chats.route.js";
import { dataLlamadasRoute } from "./routes/data/llamadas.route.js";
import { dataVideollamadasRoute } from "./routes/data/videollamadas.route.js";
import { asesoresMergeSuggestionsRoute } from "./routes/data/merge-suggestions.route.js";
import { criteriosCalificacionRoute } from "./routes/data/criterios-calificacion.route.js";
import { canalesActivosRoute } from "./routes/data/canales-activos.route.js";
import { contactIntakeRoute } from "./routes/webhooks/contact-intake.route.js";
import { metricsRoute } from "./routes/data/metrics.route.js";
import { contactoTranscripcionesRoute } from "./routes/data/contacto-transcripciones.route.js";
import { bulkTagRoute } from "./routes/data/bulk-tag.route.js";
import { ghlMarketplaceShadowRoute } from "./routes/webhooks/ghl-marketplace-shadow.route.js";
import { asistenciaWebhookRoute } from "./routes/webhooks/asistencia.route.js";
import { coachGuionRoute } from "./routes/data/coach-guion.route.js";
import { cronCoachDrainerRoute } from "./routes/cron/coach-drainer.route.js";
import { etiquetasDescarteRoute } from "./routes/data/etiquetas-descarte.route.js";
import { descartarLeadRoute } from "./routes/data/descartar-lead.route.js";
import { objecionesDetalleRoute } from "./routes/data/objeciones-detalle.route.js";
import { mapaTiemposRoute } from "./routes/data/mapa-tiempos.route.js";
import { metricasWebhookRoute } from "./routes/webhooks/metricas-webhook.route.js";
import { calificacionWebhookRoute } from "./routes/webhooks/calificacion.route.js";
import { byokBackfillRoute } from "./routes/quick-triggers/byok-backfill.route.js";
import { updateRuleExcluyeRoute } from "./routes/quick-triggers/update-rule-excluye.route.js";
import { cronChatWebhookRawRetentionRoute } from "./routes/cron/chat-webhook-raw-retention.route.js";
import { cronOutboundEnrichmentRoute } from "./routes/cron/outbound-enrichment.route.js";
import { cronObjecionesBackfillRoute } from "./routes/cron/objeciones-respuesta-backfill.route.js";
import { cronReprocessPendingChatWebhooksRoute } from "./routes/cron/reprocess-pending-chat-webhooks.route.js";
import { cronChatBackfillAutoRoute } from "./routes/cron/chat-backfill-auto.route.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
    },
  });

  await app.register(errorHandlerPlugin);

  await app.register(healthRoute);
  await app.register(fathomWebhookRoute, { prefix: "/webhooks" });
  await app.register(ghlWebhookRoute, { prefix: "/webhooks" });
  await app.register(externalDataRoute, { prefix: "/webhooks" });
  await app.register(contactIntakeRoute, { prefix: "/webhooks" });
  await app.register(orphanRoute, { prefix: "/webhooks" });
  await app.register(reasignacionRoute, { prefix: "/webhooks" });
  await app.register(reasignacionRoute); // alias: acepta /reasignacion además de /webhooks/reasignacion
  await app.register(cronDailyTasksRoute, { prefix: "/cron" });
  await app.register(cronSincronizarAdsRoute, { prefix: "/cron" });
  await app.register(cronDetectDuplicatesClosersRoute, { prefix: "/cron" });
  await app.register(cronSpeedToLeadAlertsRoute, { prefix: "/cron" });
  await app.register(cronSpeedToLeadChatAlertsRoute, { prefix: "/cron" });
  await app.register(cronWebhookRecoveryRoute, { prefix: "/cron" });
  await app.register(cronBatchAnalysisRoute, { prefix: "/cron" });
  await app.register(cronChatSinResponderTagsRoute, { prefix: "/cron" });
  await app.register(cronGeminiBackfillRoute, { prefix: "/cron" });
  await app.register(videoRecoveryRoute, { prefix: "/api/quick-triggers" });
  await app.register(chatRecoveryRoute, { prefix: "/api/quick-triggers" });
  await app.register(reprocessReglasRoute, { prefix: "/api/quick-triggers" });
  await app.register(backfillMetricasReRoute, { prefix: "/api/quick-triggers" });
  await app.register(chatBackfillRoute, { prefix: "/api/quick-triggers" });
  await app.register(byokBackfillRoute, { prefix: "/api/quick-triggers" });
  await app.register(updateRuleExcluyeRoute, { prefix: "/api/quick-triggers" });
  await app.register(chatWebhookRoute, { prefix: "/webhooks" });
  await app.register(vozWebhookRoute, { prefix: "/webhooks" });
  await app.register(ghlCallbackRoute);
  await app.register(dataChatsRoute, { prefix: "/api/data" });
  await app.register(dataLlamadasRoute, { prefix: "/api/data" });
  await app.register(dataVideollamadasRoute, { prefix: "/api/data" });
  await app.register(asesoresMergeSuggestionsRoute, { prefix: "/api/data/asesores" });
  await app.register(criteriosCalificacionRoute, { prefix: "/api" });
  await app.register(canalesActivosRoute, { prefix: "/api" });
  await app.register(metricsRoute, { prefix: "/api/v1/metrics" });
  await app.register(contactoTranscripcionesRoute, { prefix: "/data" });
  await app.register(ghlMarketplaceShadowRoute, { prefix: "/webhooks" });
  await app.register(asistenciaWebhookRoute, { prefix: "/webhooks" });
  await app.register(bulkTagRoute, { prefix: "/api" });
  await app.register(coachGuionRoute, { prefix: "/api" });
  await app.register(cronCoachDrainerRoute, { prefix: "/cron" });
  await app.register(cronChatWebhookRawRetentionRoute, { prefix: "/cron" });
  await app.register(cronOutboundEnrichmentRoute, { prefix: "/cron" });
  await app.register(cronObjecionesBackfillRoute, { prefix: "/cron" });
  await app.register(cronReprocessPendingChatWebhooksRoute, { prefix: "/cron" });
  await app.register(cronChatBackfillAutoRoute, { prefix: "/cron" });
  await app.register(etiquetasDescarteRoute, { prefix: "/api" });
  await app.register(descartarLeadRoute, { prefix: "/api" });
  await app.register(objecionesDetalleRoute, { prefix: "/api/data" });
  await app.register(mapaTiemposRoute, { prefix: "/api/data" });
  await app.register(metricasWebhookRoute, { prefix: "/webhooks" });
  await app.register(calificacionWebhookRoute, { prefix: "/webhooks" });

  return app;
}

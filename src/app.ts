import Fastify from "fastify";
import { env } from "./config/env.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { healthRoute } from "./routes/health.route.js";
import { fathomWebhookRoute } from "./routes/webhooks/fathom.route.js";
import { ghlWebhookRoute } from "./routes/webhooks/ghl.route.js";
import { twilioWebhookRoute } from "./routes/webhooks/twilio.route.js";
import { cronDailyTasksRoute } from "./routes/cron/daily-tasks.route.js";
import { cronSincronizarAdsRoute } from "./routes/cron/sincronizar-ads.route.js";
import { cronDetectDuplicatesClosersRoute } from "./routes/cron/detect-duplicates-closers.route.js";
import { cronSpeedToLeadAlertsRoute } from "./routes/cron/speed-to-lead-alerts.route.js";
import { cronSpeedToLeadChatAlertsRoute } from "./routes/cron/speed-to-lead-chat-alerts.route.js";
import { cronWebhookRecoveryRoute } from "./routes/cron/webhook-recovery.route.js";
import { externalDataRoute } from "./routes/webhooks/external-data.route.js";
import { orphanRoute } from "./routes/webhooks/orphan.route.js";
import { reasignacionRoute } from "./routes/webhooks/reasignacion.route.js";
import { videoRecoveryRoute } from "./routes/quick-triggers/video-recovery.route.js";
import { chatRecoveryRoute } from "./routes/quick-triggers/chat-recovery.route.js";
import { chatWebhookRoute } from "./routes/webhooks/chat.route.js";
import { ghlCallbackRoute } from "./routes/oauth/ghl-callback.route.js";
import { dataChatsRoute } from "./routes/data/chats.route.js";
import { asesoresMergeSuggestionsRoute } from "./routes/data/merge-suggestions.route.js";

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
  await app.register(twilioWebhookRoute, { prefix: "/webhooks" });
  await app.register(externalDataRoute, { prefix: "/webhooks" });
  await app.register(orphanRoute, { prefix: "/webhooks" });
  await app.register(reasignacionRoute, { prefix: "/webhooks" });
  await app.register(reasignacionRoute); // alias: acepta /reasignacion además de /webhooks/reasignacion
  await app.register(cronDailyTasksRoute, { prefix: "/cron" });
  await app.register(cronSincronizarAdsRoute, { prefix: "/cron" });
  await app.register(cronDetectDuplicatesClosersRoute, { prefix: "/cron" });
  await app.register(cronSpeedToLeadAlertsRoute, { prefix: "/cron" });
  await app.register(cronSpeedToLeadChatAlertsRoute, { prefix: "/cron" });
  await app.register(cronWebhookRecoveryRoute, { prefix: "/cron" });
  await app.register(videoRecoveryRoute, { prefix: "/api/quick-triggers" });
  await app.register(chatRecoveryRoute, { prefix: "/api/quick-triggers" });
  await app.register(chatWebhookRoute, { prefix: "/webhooks" });
  await app.register(ghlCallbackRoute);
  await app.register(dataChatsRoute, { prefix: "/api/data" });
  await app.register(asesoresMergeSuggestionsRoute, { prefix: "/api/data/asesores" });

  return app;
}

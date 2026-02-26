import Fastify from "fastify";
import { env } from "./config/env.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { healthRoute } from "./routes/health.route.js";
import { fathomWebhookRoute } from "./routes/webhooks/fathom.route.js";
import { ghlWebhookRoute } from "./routes/webhooks/ghl.route.js";
import { twilioWebhookRoute } from "./routes/webhooks/twilio.route.js";
import { cronDailyTasksRoute } from "./routes/cron/daily-tasks.route.js";

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
  await app.register(cronDailyTasksRoute, { prefix: "/cron" });

  return app;
}

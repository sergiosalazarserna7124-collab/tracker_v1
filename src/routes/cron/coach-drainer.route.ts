import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import { env } from "../../config/env.js";
import { runCoachDrainer } from "../../services/cron/coach-drainer.service.js";

const CronHeaders = Type.Object(
  { "x-cron-secret": Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);

async function handleCoachDrainer(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const secret = request.headers["x-cron-secret"];
  if (secret !== env.CRON_SECRET) {
    return reply.status(401).send({ success: false, error: "Unauthorized" });
  }

  try {
    const result = await runCoachDrainer();
    return reply.send({ success: true, ...result });
  } catch (err) {
    console.error("[handleCoachDrainer] Error:", err);
    return reply.status(500).send({ success: false, error: "Error interno en coach-drainer" });
  }
}

export async function cronCoachDrainerRoute(app: FastifyInstance) {
  app.addContentTypeParser(
    "*",
    { parseAs: "string" },
    (_req, body, done) => {
      const raw = typeof body === "string" ? body.trim() : "";
      if (raw) {
        try {
          done(null, JSON.parse(raw));
        } catch {
          done(null, {});
        }
      } else {
        done(null, {});
      }
    },
  );

  app.addHook("preValidation", async (request) => {
    if (request.body == null) {
      (request as unknown as { body: Record<string, never> }).body = {};
    }
  });

  app.post(
    "/coach-drainer",
    {
      schema: {
        headers: CronHeaders,
      },
    },
    handleCoachDrainer,
  );
}

import type { FastifyInstance } from "fastify";
import { handleGhlMarketplaceShadow } from "../../controllers/webhooks/ghl-marketplace-shadow.controller.js";

export async function ghlMarketplaceShadowRoute(app: FastifyInstance) {
  app.post("/ghl-marketplace", handleGhlMarketplaceShadow);
}

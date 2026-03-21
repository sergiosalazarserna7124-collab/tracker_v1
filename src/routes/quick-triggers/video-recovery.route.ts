import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import {
  VideoRecoveryExecuteBody,
  VideoRecoveryPreviewBody,
  type VideoRecoveryExecuteBodyType,
  type VideoRecoveryPreviewBodyType,
} from "../../schemas/quick-triggers/video-recovery.schema.js";
import {
  handleVideoRecoveryExecute,
  handleVideoRecoveryPreview,
} from "../../controllers/quick-triggers/video-recovery.controller.js";

export async function videoRecoveryRoute(app: FastifyInstance) {
  app.post<{ Body: VideoRecoveryPreviewBodyType }>(
    "/video-recovery/preview",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        body: VideoRecoveryPreviewBody,
      },
    },
    handleVideoRecoveryPreview,
  );

  app.post<{ Body: VideoRecoveryExecuteBodyType }>(
    "/video-recovery/execute",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        body: VideoRecoveryExecuteBody,
      },
    },
    handleVideoRecoveryExecute,
  );
}

import type { FastifyInstance } from "fastify";
import { apiKeyAuthHook } from "../../hooks/api-key-auth.hook.js";
import {
  VideoRecoveryExecuteBody,
  VideoRecoveryPreviewBody,
  VideoRecoveryRelinkBody,
  VideoRecoveryAgendaSearchBody,
  type VideoRecoveryExecuteBodyType,
  type VideoRecoveryPreviewBodyType,
  type VideoRecoveryRelinkBodyType,
  type VideoRecoveryAgendaSearchBodyType,
} from "../../schemas/quick-triggers/video-recovery.schema.js";
import {
  handleVideoRecoveryExecute,
  handleVideoRecoveryPreview,
  handleVideoRecoveryRelink,
  handleVideoRecoveryAgendaSearch,
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

  app.post<{ Body: VideoRecoveryRelinkBodyType }>(
    "/video-recovery/relink",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        body: VideoRecoveryRelinkBody,
      },
    },
    handleVideoRecoveryRelink,
  );

  app.post<{ Body: VideoRecoveryAgendaSearchBodyType }>(
    "/video-recovery/agenda-search",
    {
      preHandler: [apiKeyAuthHook],
      schema: {
        body: VideoRecoveryAgendaSearchBody,
      },
    },
    handleVideoRecoveryAgendaSearch,
  );
}

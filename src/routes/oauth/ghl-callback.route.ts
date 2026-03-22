import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { env } from "../../config/env.js";
import { exchangeCodeForTokens } from "../../services/oauth/ghl-oauth.service.js";

const HTML_SUCCESS = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>AutoKPI Conectado</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f9f0;}
.card{background:#fff;border-radius:12px;padding:2rem 3rem;box-shadow:0 4px 20px rgba(0,0,0,.08);text-align:center;}
h1{font-size:2rem;color:#22c55e;margin-bottom:.5rem;}p{color:#555;font-size:1rem;}</style>
</head>
<body><div class="card"><h1>✅ AutoKPI conectado correctamente</h1><p>Ya puedes cerrar esta ventana.</p></div></body>
</html>`;

function buildHtmlError(message: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Error de conexión</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fff5f5;}
.card{background:#fff;border-radius:12px;padding:2rem 3rem;box-shadow:0 4px 20px rgba(0,0,0,.08);text-align:center;}
h1{font-size:1.5rem;color:#ef4444;margin-bottom:.5rem;}p{color:#888;font-size:.9rem;}</style>
</head>
<body><div class="card"><h1>❌ Error de conexión</h1><p>${message}</p></div></body>
</html>`;
}

interface OAuthCallbackQuery {
  code?: string;
  locationId?: string;
  location_id?: string;
}

export async function ghlCallbackRoute(app: FastifyInstance): Promise<void> {
  app.get(
    "/oauth/callback",
    async (
      request: FastifyRequest<{ Querystring: OAuthCallbackQuery }>,
      reply: FastifyReply,
    ) => {
      const { code, locationId, location_id } = request.query;
      const resolvedLocationId = locationId ?? location_id ?? "";

      if (!code || !resolvedLocationId) {
        const missing = !code ? "code" : "locationId";
        request.log.warn(`[OAuthCallback] Parámetro faltante: ${missing}`);
        return reply
          .code(400)
          .header("Content-Type", "text/html; charset=utf-8")
          .send(buildHtmlError(`Parámetro requerido faltante: ${missing}`));
      }

      try {
        await exchangeCodeForTokens(code, resolvedLocationId, env.GHL_OAUTH_REDIRECT_URI);

        request.log.info(
          `[OAuthCallback] ✅ Tokens guardados — locationId="${resolvedLocationId}"`,
        );

        return reply
          .code(200)
          .header("Content-Type", "text/html; charset=utf-8")
          .send(HTML_SUCCESS);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.error(`[OAuthCallback] Error intercambiando tokens: ${message}`);

        return reply
          .code(500)
          .header("Content-Type", "text/html; charset=utf-8")
          .send(buildHtmlError(`Error interno al conectar con GHL: ${message}`));
      }
    },
  );
}

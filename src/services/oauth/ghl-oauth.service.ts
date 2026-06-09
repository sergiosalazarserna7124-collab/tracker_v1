/**
 * GHL OAuth Service
 * Handles token exchange, refresh, and retrieval for GHL Marketplace OAuth2 flow.
 */

import { db } from "../../config/database.js";
import { env } from "../../config/env.js";
import { withRetry } from "../../utils/retry.utils.js";
import { markTokenOk, retryPendingActions } from "../ghl-token-guard.service.js";

const GHL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";

// ─── Types ────────────────────────────────────────────────────────────────────

interface GhlTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  userType?: string;
  locationId?: string;
  companyId?: string;
}

// ─── exchangeCodeForTokens ────────────────────────────────────────────────────

/**
 * Intercambia el code de OAuth por access_token + refresh_token.
 * Guarda/actualiza en ghl_oauth_tokens. Si encuentra la cuenta por locationId,
 * linkea id_cuenta automáticamente.
 */
export async function exchangeCodeForTokens(
  code: string,
  locationId: string,
  redirectUri: string,
): Promise<GhlTokenResponse> {
  const body = new URLSearchParams({
    client_id: env.GHL_APP_CLIENT_ID,
    client_secret: env.GHL_APP_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const res = await fetch(GHL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL token exchange failed (${res.status}): ${text}`);
  }

  const tokenData = (await res.json()) as GhlTokenResponse;

  // Calcular expires_at
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

  // Buscar si existe cuenta con este locationId para linkear
  const { rows: cuentaRows } = await withRetry(
    () =>
      db.query<{ id_cuenta: number }>(
        `SELECT id_cuenta FROM cuentas WHERE locationid = $1 LIMIT 1`,
        [locationId],
      ),
    { label: "ghlOauth/findCuenta" },
  );
  const idCuenta = cuentaRows[0]?.id_cuenta ?? null;

  // Upsert en ghl_oauth_tokens
  await withRetry(
    () =>
      db.query(
        `INSERT INTO ghl_oauth_tokens
           (location_id, id_cuenta, access_token, refresh_token, token_type,
            expires_in, scope, expires_at, last_refreshed_at, user_type, company_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10)
         ON CONFLICT (location_id) DO UPDATE SET
           id_cuenta        = COALESCE($2, ghl_oauth_tokens.id_cuenta),
           access_token     = EXCLUDED.access_token,
           refresh_token    = EXCLUDED.refresh_token,
           token_type       = EXCLUDED.token_type,
           expires_in       = EXCLUDED.expires_in,
           scope            = EXCLUDED.scope,
           expires_at       = EXCLUDED.expires_at,
           last_refreshed_at = NOW(),
           user_type        = EXCLUDED.user_type,
           company_id       = EXCLUDED.company_id`,
        [
          locationId,
          idCuenta,
          tokenData.access_token,
          tokenData.refresh_token,
          tokenData.token_type ?? "Bearer",
          tokenData.expires_in,
          tokenData.scope ?? null,
          expiresAt.toISOString(),
          tokenData.userType ?? null,
          tokenData.companyId ?? null,
        ],
      ),
    { label: "ghlOauth/upsertTokens" },
  );

  console.log(
    `[GhlOAuth] Tokens guardados para locationId="${locationId}" | id_cuenta=${idCuenta ?? "no encontrada"}`,
  );

  if (idCuenta) {
    await markTokenOk(idCuenta);
    retryPendingActions(idCuenta, tokenData.access_token).catch((err) =>
      console.error(`[GhlOAuth] Error reintentando pendientes cuenta=${idCuenta}:`, err),
    );
  }

  return tokenData;
}

// ─── refreshTokens ────────────────────────────────────────────────────────────

/**
 * Usa el refresh_token almacenado para obtener nuevos tokens de GHL.
 * Actualiza la BD con el resultado.
 */
export async function refreshTokens(locationId: string): Promise<GhlTokenResponse> {
  // Leer refresh_token de BD
  const { rows } = await withRetry(
    () =>
      db.query<{ refresh_token: string; id_cuenta: number | null }>(
        `SELECT refresh_token, id_cuenta FROM ghl_oauth_tokens WHERE location_id = $1 LIMIT 1`,
        [locationId],
      ),
    { label: "ghlOauth/readRefreshToken" },
  );

  if (!rows[0]) {
    throw new Error(`No hay tokens almacenados para locationId="${locationId}"`);
  }

  const { refresh_token, id_cuenta } = rows[0];

  const body = new URLSearchParams({
    client_id: env.GHL_APP_CLIENT_ID,
    client_secret: env.GHL_APP_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token,
  });

  const res = await fetch(GHL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL token refresh failed (${res.status}): ${text}`);
  }

  const tokenData = (await res.json()) as GhlTokenResponse;
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

  await withRetry(
    () =>
      db.query(
        `UPDATE ghl_oauth_tokens SET
           access_token      = $1,
           refresh_token     = $2,
           expires_in        = $3,
           expires_at        = $4,
           last_refreshed_at = NOW()
         WHERE location_id = $5`,
        [
          tokenData.access_token,
          tokenData.refresh_token,
          tokenData.expires_in,
          expiresAt.toISOString(),
          locationId,
        ],
      ),
    { label: "ghlOauth/updateRefreshedTokens" },
  );

  console.log(`[GhlOAuth] Tokens refrescados para locationId="${locationId}" | id_cuenta=${id_cuenta ?? "none"}`);

  return tokenData;
}

// ─── getAccessToken ───────────────────────────────────────────────────────────

/**
 * Obtiene un access_token válido para el locationId dado.
 * Si el token está expirado (o a punto de expirar en <60s), lo refresca automáticamente.
 * Retorna null si no hay tokens almacenados.
 */
export async function getAccessToken(locationId: string): Promise<string | null> {
  const { rows } = await withRetry(
    () =>
      db.query<{ access_token: string; expires_at: Date | null }>(
        `SELECT access_token, expires_at FROM ghl_oauth_tokens WHERE location_id = $1 LIMIT 1`,
        [locationId],
      ),
    { label: "ghlOauth/getAccessToken" },
  );

  if (!rows[0]) return null;

  const { access_token, expires_at } = rows[0];

  // Refrescar si expira en menos de 60 segundos
  const isExpired = expires_at !== null && expires_at.getTime() - Date.now() < 60_000;

  if (isExpired) {
    try {
      const refreshed = await refreshTokens(locationId);
      return refreshed.access_token;
    } catch (err) {
      console.error(`[GhlOAuth] Error refrescando token para locationId="${locationId}":`, err);
      return null;
    }
  }

  return access_token;
}

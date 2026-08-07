/**
 * GHL OAuth Service
 * Handles token exchange, refresh, and retrieval for GHL Marketplace OAuth2 flow.
 */

import { db } from "../../config/database.js";
import { env } from "../../config/env.js";
import { withRetry } from "../../utils/retry.utils.js";
import { markTokenOk, retryPendingActions } from "../ghl-token-guard.service.js";

const GHL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
const GHL_LOCATION_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/locationToken";
const GHL_INSTALLED_LOCATIONS_URL = "https://services.leadconnectorhq.com/oauth/installedLocations";

/** El appId es el primer segmento del client_id (formato "<appId>-<keyId>"). */
function getAppId(): string {
  return (env.GHL_APP_CLIENT_ID.split("-")[0] ?? "").trim();
}

/** Clave sintética para guardar el token de Agencia (Company) en la misma tabla. */
function companyKey(companyId: string): string {
  return `company:${companyId}`;
}

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

// ─── Helper: upsert de un token en ghl_oauth_tokens ──────────────────────────

async function upsertToken(
  locationIdColumn: string,
  tokenData: GhlTokenResponse,
  linkCuentaByLocationId: string | null,
): Promise<number | null> {
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

  let idCuenta: number | null = null;
  if (linkCuentaByLocationId) {
    const { rows } = await withRetry(
      () =>
        db.query<{ id_cuenta: number }>(
          `SELECT id_cuenta FROM cuentas WHERE locationid = $1 LIMIT 1`,
          [linkCuentaByLocationId],
        ),
      { label: "ghlOauth/findCuenta" },
    );
    idCuenta = rows[0]?.id_cuenta ?? null;
  }

  await withRetry(
    () =>
      db.query(
        `INSERT INTO ghl_oauth_tokens
           (location_id, id_cuenta, access_token, refresh_token, token_type,
            expires_in, scope, expires_at, last_refreshed_at, user_type, company_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10)
         ON CONFLICT (location_id) DO UPDATE SET
           id_cuenta         = COALESCE($2, ghl_oauth_tokens.id_cuenta),
           access_token      = EXCLUDED.access_token,
           refresh_token     = EXCLUDED.refresh_token,
           token_type        = EXCLUDED.token_type,
           expires_in        = EXCLUDED.expires_in,
           scope             = EXCLUDED.scope,
           expires_at        = EXCLUDED.expires_at,
           last_refreshed_at = NOW(),
           user_type         = EXCLUDED.user_type,
           company_id        = EXCLUDED.company_id`,
        [
          locationIdColumn,
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

  return idCuenta;
}

// ─── Helper: minta un token de Location a partir del token de Company ─────────

async function getLocationTokenFromCompany(
  companyId: string,
  locationId: string,
  companyAccessToken: string,
): Promise<GhlTokenResponse> {
  const body = new URLSearchParams({ companyId, locationId });
  const res = await fetch(GHL_LOCATION_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${companyAccessToken}`,
      Version: "2021-07-28",
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL locationToken failed (${res.status}) para location=${locationId}: ${text}`);
  }
  const data = (await res.json()) as GhlTokenResponse;
  if (!data.locationId) data.locationId = locationId;
  if (!data.companyId) data.companyId = companyId;
  return data;
}

// ─── Helper: lista los locationIds donde está instalada la app ────────────────

async function fetchInstalledLocationIds(
  companyId: string,
  companyAccessToken: string,
): Promise<string[]> {
  const appId = getAppId();
  const url = `${GHL_INSTALLED_LOCATIONS_URL}?companyId=${encodeURIComponent(companyId)}&appId=${encodeURIComponent(appId)}&limit=500`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${companyAccessToken}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL installedLocations failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { locations?: Array<{ _id?: string; id?: string }> };
  return (data.locations ?? [])
    .map((l) => l._id ?? l.id)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
}

// ─── Provisiona (minta+guarda) el token de UNA location desde el company token ─

async function provisionLocationToken(
  companyId: string,
  locationId: string,
  companyAccessToken: string,
): Promise<void> {
  const locTokenData = await getLocationTokenFromCompany(companyId, locationId, companyAccessToken);
  const idCuenta = await upsertToken(locationId, locTokenData, locationId);
  console.log(
    `[GhlOAuth] Location token guardado location=${locationId} | id_cuenta=${idCuenta ?? "no encontrada"}`,
  );
  if (idCuenta) {
    await markTokenOk(idCuenta);
    retryPendingActions(idCuenta, locTokenData.access_token).catch((err) =>
      console.error(`[GhlOAuth] Error reintentando pendientes cuenta=${idCuenta}:`, err),
    );
  }
}

// ─── Provisiona TODAS las locations de una instalación de Agencia (Company) ────

async function provisionCompanyInstall(companyTokenData: GhlTokenResponse): Promise<void> {
  const companyId = companyTokenData.companyId!;
  // 1. Guardar el token de Company (para refrescarlo y mintar locations futuras)
  await upsertToken(companyKey(companyId), companyTokenData, null);
  console.log(`[GhlOAuth] Company token guardado companyId=${companyId}`);

  // 2. Listar las locations instaladas y mintar un token por cada una
  let locationIds: string[] = [];
  try {
    locationIds = await fetchInstalledLocationIds(companyId, companyTokenData.access_token);
  } catch (err) {
    console.error(`[GhlOAuth] No se pudieron listar installedLocations:`, err);
  }

  console.log(`[GhlOAuth] Agencia companyId=${companyId} → ${locationIds.length} location(s) instaladas`);
  for (const locationId of locationIds) {
    try {
      await provisionLocationToken(companyId, locationId, companyTokenData.access_token);
    } catch (err) {
      console.error(`[GhlOAuth] Error provisionando location=${locationId}:`, err);
    }
  }
}

// ─── Provisiona una location futura (desde el webhook INSTALL) ─────────────────

/**
 * Usa el token de Company ya guardado para mintar+guardar el token de una
 * location que se instaló DESPUÉS (evento INSTALL del webhook de la app).
 */
export async function provisionLocationFromStoredCompany(
  companyId: string,
  locationId: string,
): Promise<void> {
  const companyAccessToken = await getAccessToken(companyKey(companyId));
  if (!companyAccessToken) {
    throw new Error(`No hay company token almacenado para companyId=${companyId}`);
  }
  await provisionLocationToken(companyId, locationId, companyAccessToken);
}

// ─── exchangeCodeForTokens ────────────────────────────────────────────────────

/**
 * Intercambia el code de OAuth por tokens y los guarda.
 *  - Instalación a nivel Location → guarda ese token directo.
 *  - Instalación a nivel Agencia (Company) → guarda el token de Company y
 *    minta+guarda un token de Location por cada subcuenta instalada. Las
 *    locations futuras se auto-conectan vía el webhook INSTALL.
 */
export async function exchangeCodeForTokens(
  code: string,
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

  // ── Instalación a nivel Location ────────────────────────────────────────────
  if (tokenData.locationId) {
    const idCuenta = await upsertToken(tokenData.locationId, tokenData, tokenData.locationId);
    console.log(
      `[GhlOAuth] Tokens guardados (Location) location="${tokenData.locationId}" | id_cuenta=${idCuenta ?? "no encontrada"}`,
    );
    if (idCuenta) {
      await markTokenOk(idCuenta);
      retryPendingActions(idCuenta, tokenData.access_token).catch((err) =>
        console.error(`[GhlOAuth] Error reintentando pendientes cuenta=${idCuenta}:`, err),
      );
    }
    return tokenData;
  }

  // ── Instalación a nivel Agencia (Company) ───────────────────────────────────
  if (tokenData.companyId) {
    await provisionCompanyInstall(tokenData);
    return tokenData;
  }

  throw new Error(
    `La respuesta de GHL no incluyó locationId ni companyId (userType=${tokenData.userType ?? "desconocido"}).`,
  );
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

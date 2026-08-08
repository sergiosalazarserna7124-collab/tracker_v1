/**
 * Sync automático de usuarios GHL → usuarios_dashboard.
 *
 * Por cada location con la app instalada se listan sus usuarios
 * (GET /users/?locationId=) y se hace upsert en usuarios_dashboard:
 *   - GHL role "admin"  → rol "superadmin" (acceso a todo)
 *   - GHL role "user"   → rol "usuario"    (solo ve datos asignados a él)
 *
 * GHL es la ÚNICA fuente de verdad: los usuarios no se editan en Lead Master,
 * así que el sync también refresca rol y nombre en cada corrida.
 * Requiere el scope users.readonly en la app del marketplace.
 */

import { db } from "../config/database.js";
import { withRetry } from "../utils/retry.utils.js";
import { fetchWithTimeout } from "../utils/fetch.utils.js";
import { getAccessToken } from "./oauth/ghl-oauth.service.js";

const GHL_USERS_URL = "https://services.leadconnectorhq.com/users/";
const GHL_TIMEOUT_MS = 15_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface GhlLocationUser {
  id: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  deleted?: boolean;
  roles?: {
    type?: string; // "account" | "agency"
    role?: string; // "admin" | "user"
    locationIds?: string[];
  };
}

export interface SyncCuentaResult {
  id_cuenta: number;
  location_id: string;
  creados: number;
  actualizados: number;
  desactivados: number;
  omitidos: number;
  error?: string;
}

// ─── GHL API ──────────────────────────────────────────────────────────────────

async function fetchGhlLocationUsers(
  locationId: string,
  bearerToken: string,
): Promise<GhlLocationUser[]> {
  const url = `${GHL_USERS_URL}?locationId=${encodeURIComponent(locationId)}`;
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: "application/json",
        Version: "2021-07-28",
      },
    },
    GHL_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GHL users API responded ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { users?: GhlLocationUser[] };
  return data.users ?? [];
}

// ─── Upsert de un usuario ─────────────────────────────────────────────────────

function mapRol(ghlUser: GhlLocationUser): string {
  return ghlUser.roles?.role === "admin" ? "superadmin" : "usuario";
}

function buildNombre(u: GhlLocationUser): string | null {
  if (u.name?.trim()) return u.name.trim();
  const partes = [u.firstName, u.lastName].filter((p) => p?.trim());
  return partes.length > 0 ? partes.join(" ").trim() : null;
}

/** @returns "creado" | "actualizado" | "omitido" */
async function upsertUsuario(
  idCuenta: number,
  ghlUser: GhlLocationUser,
): Promise<"creado" | "actualizado" | "omitido"> {
  const email = ghlUser.email?.trim().toLowerCase();
  if (!email || ghlUser.deleted) return "omitido";

  const nombre = buildNombre(ghlUser);

  // Buscar primero por ghl_user_id (sobrevive a cambios de email en GHL),
  // luego por email (usuarios creados a mano antes del sync).
  const { rows } = await withRetry(
    () =>
      db.query<{ id_evento: number }>(
        `SELECT id_evento
           FROM usuarios_dashboard
          WHERE id_cuenta = $1
            AND (ghl_user_id = $2 OR lower(email) = $3)
          ORDER BY (ghl_user_id = $2) DESC
          LIMIT 1`,
        [idCuenta, ghlUser.id, email],
      ),
    { label: "ghlUsersSync/find" },
  );

  const rol = mapRol(ghlUser);

  if (rows[0]) {
    // Existente: GHL manda — refrescar también rol y nombre en cada sync.
    await withRetry(
      () =>
        db.query(
          `UPDATE usuarios_dashboard SET
             ghl_user_id   = $2,
             email         = $3,
             nombre        = COALESCE($4, nombre),
             nombre_closer = COALESCE(nombre_closer, $4),
             rol           = $5,
             activo        = TRUE,
             ghl_synced_at = NOW()
           WHERE id_evento = $1`,
          [rows[0].id_evento, ghlUser.id, email, nombre, rol],
        ),
      { label: "ghlUsersSync/update" },
    );
    return "actualizado";
  }

  await withRetry(
    () =>
      db.query(
        `INSERT INTO usuarios_dashboard
           (id_cuenta, nombre, email, pass, rol, nombre_closer, tipo_usuario,
            ghl_user_id, origen, activo, ghl_synced_at)
         VALUES ($1, $2, $3, NULL, $4, $2, 'analista', $5, 'ghl', TRUE, NOW())`,
        [idCuenta, nombre, email, rol, ghlUser.id],
      ),
    { label: "ghlUsersSync/insert" },
  );
  return "creado";
}

// ─── Sync de una cuenta/location ──────────────────────────────────────────────

export async function syncUsersForLocation(
  idCuenta: number,
  locationId: string,
): Promise<SyncCuentaResult> {
  const result: SyncCuentaResult = {
    id_cuenta: idCuenta,
    location_id: locationId,
    creados: 0,
    actualizados: 0,
    desactivados: 0,
    omitidos: 0,
  };

  const token = await getAccessToken(locationId);
  if (!token) {
    result.error = `Sin token OAuth para location=${locationId}`;
    return result;
  }

  const ghlUsers = await fetchGhlLocationUsers(locationId, token);

  for (const ghlUser of ghlUsers) {
    try {
      const accion = await upsertUsuario(idCuenta, ghlUser);
      if (accion === "creado") result.creados++;
      else if (accion === "actualizado") result.actualizados++;
      else result.omitidos++;
    } catch (err) {
      result.omitidos++;
      console.error(
        `[GhlUsersSync] Error upsert usuario ghl_id=${ghlUser.id} cuenta=${idCuenta}:`,
        err,
      );
    }
  }

  // Usuarios creados por el sync que ya no están en la location → desactivar.
  // Los creados a mano (origen='manual') nunca se tocan.
  const idsActivos = ghlUsers.filter((u) => !u.deleted).map((u) => u.id);
  const { rowCount } = await withRetry(
    () =>
      db.query(
        `UPDATE usuarios_dashboard SET activo = FALSE, ghl_synced_at = NOW()
          WHERE id_cuenta = $1
            AND origen = 'ghl'
            AND activo = TRUE
            AND ghl_user_id IS NOT NULL
            AND NOT (ghl_user_id = ANY($2::text[]))`,
        [idCuenta, idsActivos],
      ),
    { label: "ghlUsersSync/deactivate" },
  );
  result.desactivados = rowCount ?? 0;

  console.log(
    `[GhlUsersSync] cuenta=${idCuenta} location=${locationId}: ` +
      `${result.creados} creados, ${result.actualizados} actualizados, ` +
      `${result.desactivados} desactivados, ${result.omitidos} omitidos`,
  );
  return result;
}

// ─── Sync de todas las cuentas con app instalada ──────────────────────────────

export async function syncAllGhlUsers(): Promise<SyncCuentaResult[]> {
  const { rows } = await withRetry(
    () =>
      db.query<{ id_cuenta: number; location_id: string }>(
        `SELECT t.id_cuenta, t.location_id
           FROM ghl_oauth_tokens t
          WHERE t.id_cuenta IS NOT NULL
            AND t.location_id NOT LIKE 'company:%'
          ORDER BY t.id_cuenta`,
      ),
    { label: "ghlUsersSync/listCuentas" },
  );

  const results: SyncCuentaResult[] = [];
  for (const { id_cuenta, location_id } of rows) {
    try {
      results.push(await syncUsersForLocation(id_cuenta, location_id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GhlUsersSync] Error cuenta=${id_cuenta}:`, err);
      results.push({
        id_cuenta,
        location_id,
        creados: 0,
        actualizados: 0,
        desactivados: 0,
        omitidos: 0,
        error: message,
      });
    }
  }
  return results;
}

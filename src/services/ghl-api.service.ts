import { eq } from "drizzle-orm";
import { drizzleDb } from "../config/drizzle.js";
import { cuentas } from "../db/schema.js";
import { fetchWithTimeout } from "../utils/fetch.utils.js";
import { withRetry } from "../utils/retry.utils.js";

const GHL_TIMEOUT_MS = 15_000;

// ─── Helper: normalizar token de GHL ─────────────────────────────────────────
// Garantiza que el header Authorization sea siempre "Bearer <token>",
// independientemente de cómo esté guardado en la BD (con o sin prefijo).

function buildBearerAuth(rawToken: string): string {
  const trimmed = rawToken.trim();
  // Si ya tiene el prefijo (cualquier capitalización), lo devuelve limpio
  if (/^bearer\s+/i.test(trimmed)) {
    return trimmed;
  }
  return `Bearer ${trimmed}`;
}

// ─── Tipos ────────────────────────────────────────────────────────────────────
// Los campos text() de Drizzle sin .notNull() son string | null.

export interface CuentaRow {
  id_cuenta: number;
  nombre_cuenta: string | null;
  locationid: string | null;
  token_ghl: string | null;
}

export interface CuentaFullRow extends CuentaRow {
  twilio_sid: string | null;
  auth_twilio: string | null;
  openai_api_key: string | null;
  embudo_personalizado: unknown;
  prompt_ventas: string | null;
  prompt_llamadas: string | null;
  reglas_etiquetas: unknown;
}

export interface GhlContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  assignedTo: string | null;
  utmContent: string | null;
}

export interface GhlUser {
  id: string;
  email: string | null;
  name: string | null;
}

// ─── Tags por categoría ───────────────────────────────────────────────────────

export const GHL_TAGS = {
  pendiente: "pdteautoia",
  cancelada: "canceladaautoia",
  reagenda: "reagendadoautoia",
  noshow: "noshowautoia",
  cerrada: "cerradaautoia",
  ofertada: "ofertadaautoia",
  noofertada: "noofertadaautoia",
  no_contestada_llamada: "no_contestallamadaautoia",
  interesado_llamada: "interesadollamadaautoia",
  programado_llamada: "programadollamadaautoia",
  no_interesado_llamada: "no_interesadollamadaautoia",
  contestada_llamada: "contestada_autoia_llamada",
  videollamada_efectiva: "videollamada_efectiva_autoia",
} as const;

// ─── Consulta a BD: buscar cuenta por locationid (match exacto) ───────────────

export async function getAccountByLocationId(locationId: string): Promise<CuentaRow | null> {
  const rows = await withRetry(
    () =>
      drizzleDb
        .select({
          id_cuenta: cuentas.id_cuenta,
          nombre_cuenta: cuentas.nombre_cuenta,
          locationid: cuentas.locationid,
          token_ghl: cuentas.token_ghl,
        })
        .from(cuentas)
        .where(eq(cuentas.locationid, locationId))
        .limit(1),
    { label: "getAccountByLocationId" },
  );

  return rows[0] ?? null;
}

// ─── Consulta a BD: buscar cuenta por id_cuenta ──────────────────────────────

export async function getAccountById(idCuenta: number): Promise<CuentaRow | null> {
  const rows = await withRetry(
    () =>
      drizzleDb
        .select({
          id_cuenta: cuentas.id_cuenta,
          nombre_cuenta: cuentas.nombre_cuenta,
          locationid: cuentas.locationid,
          token_ghl: cuentas.token_ghl,
        })
        .from(cuentas)
        .where(eq(cuentas.id_cuenta, idCuenta))
        .limit(1),
    { label: "getAccountById" },
  );

  return rows[0] ?? null;
}

// ─── Consulta a BD: buscar cuenta completa por id_cuenta ─────────────────────

export async function getAccountFullById(idCuenta: number): Promise<CuentaFullRow | null> {
  const rows = await withRetry(
    () =>
      drizzleDb
        .select({
          id_cuenta: cuentas.id_cuenta,
          nombre_cuenta: cuentas.nombre_cuenta,
          locationid: cuentas.locationid,
          token_ghl: cuentas.token_ghl,
          twilio_sid: cuentas.twilio_sid,
          auth_twilio: cuentas.auth_twilio,
          openai_api_key: cuentas.openai_api_key,
          embudo_personalizado: cuentas.embudo_personalizado,
          prompt_ventas: cuentas.prompt_ventas,
          prompt_llamadas: cuentas.prompt_llamadas,
          reglas_etiquetas: cuentas.reglas_etiquetas,
        })
        .from(cuentas)
        .where(eq(cuentas.id_cuenta, idCuenta))
        .limit(1),
    { label: "getAccountFullById" },
  );

  return rows[0] ?? null;
}

// ─── Consulta a BD: buscar cuenta con datos de Twilio incluidos ──────────────

export async function getAccountFullByLocationId(locationId: string): Promise<CuentaFullRow | null> {
  const rows = await withRetry(
    () =>
      drizzleDb
        .select({
          id_cuenta: cuentas.id_cuenta,
          nombre_cuenta: cuentas.nombre_cuenta,
          locationid: cuentas.locationid,
          token_ghl: cuentas.token_ghl,
          twilio_sid: cuentas.twilio_sid,
          auth_twilio: cuentas.auth_twilio,
          openai_api_key: cuentas.openai_api_key,
          embudo_personalizado: cuentas.embudo_personalizado,
          prompt_ventas: cuentas.prompt_ventas,
          prompt_llamadas: cuentas.prompt_llamadas,
          reglas_etiquetas: cuentas.reglas_etiquetas,
        })
        .from(cuentas)
        .where(eq(cuentas.locationid, locationId))
        .limit(1),
    { label: "getAccountFullByLocationId" },
  );

  return rows[0] ?? null;
}

// ─── GHL API: buscar contacto por email en una ubicación ─────────────────────

export async function searchContactByEmail(
  locationId: string,
  email: string,
  bearerToken: string,
): Promise<GhlContact | null> {
  const url = new URL("https://services.leadconnectorhq.com/contacts/");
  url.searchParams.set("locationId", locationId);
  url.searchParams.set("query", email);

  const response = await fetchWithTimeout(
    url.toString(),
    {
      method: "GET",
      headers: {
        Authorization: buildBearerAuth(bearerToken),
        Accept: "application/json",
        Version: "2021-07-28",
      },
    },
    GHL_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GHL contacts search responded ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    contacts?: Array<{
      id: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      assignedTo?: string;
      attributionSource?: { utmContent?: string };
    }>;
  };

  const contact = data.contacts?.[0];
  if (!contact) return null;

  return {
    id: contact.id,
    firstName: contact.firstName ?? null,
    lastName: contact.lastName ?? null,
    email: contact.email ?? null,
    assignedTo: contact.assignedTo ?? null,
    utmContent: contact.attributionSource?.utmContent ?? null,
  };
}

// ─── GHL API: obtener usuario por ID (para el email del closer) ───────────────

export async function getGhlUser(
  userId: string,
  bearerToken: string,
): Promise<GhlUser | null> {
  const response = await fetchWithTimeout(
    `https://services.leadconnectorhq.com/users/${userId}`,
    {
      method: "GET",
      headers: {
        Authorization: buildBearerAuth(bearerToken),
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

  const data = (await response.json()) as {
    id?: string;
    email?: string;
    name?: string;
  };

  return {
    id: data.id ?? userId,
    email: data.email ?? null,
    name: data.name ?? null,
  };
}

// ─── POST a GHL API: agregar tag al contacto ─────────────────────────────────

export async function addContactTag(
  contactId: string,
  bearerToken: string,
  tag: string,
): Promise<void> {
  const url = `https://services.leadconnectorhq.com/contacts/${contactId}/tags`;
  const authHeader = buildBearerAuth(bearerToken);
  const requestBody = JSON.stringify({ tags: [tag] });

  const headers = {
    Authorization: authHeader,
    Accept: "application/json",
    "Content-Type": "application/json",
    Version: "2021-07-28",
  };

  // ── Verbose logging para diagnosticar 401 ────────────────────────────────
  console.log("[GHL addContactTag] ── REQUEST ──────────────────────────────");
  console.log("[GHL addContactTag] URL    :", url);
  console.log("[GHL addContactTag] Headers:", JSON.stringify(headers, null, 2));
  console.log("[GHL addContactTag] Body   :", requestBody);
  console.log("[GHL addContactTag] ─────────────────────────────────────────");

  const response = await fetchWithTimeout(url, { method: "POST", headers, body: requestBody }, GHL_TIMEOUT_MS);

  console.log("[GHL addContactTag] Response status:", response.status);

  if (!response.ok) {
    const text = await response.text();
    console.error("[GHL addContactTag] ERROR response body:", text);
    throw new Error(`GHL tag API responded ${response.status}: ${text}`);
  }
}

// ─── POST a GHL API: agregar nota al contacto ────────────────────────────────

export async function addContactNote(
  contactId: string,
  bearerToken: string,
  noteBody: string,
  userId?: string,
): Promise<void> {
  const payload: Record<string, string> = { body: noteBody };
  if (userId) payload.userId = userId;

  const response = await fetchWithTimeout(
    `https://services.leadconnectorhq.com/contacts/${contactId}/notes`,
    {
      method: "POST",
      headers: {
        Authorization: buildBearerAuth(bearerToken),
        Accept: "application/json",
        "Content-Type": "application/json",
        Version: "2021-07-28",
      },
      body: JSON.stringify(payload),
    },
    GHL_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GHL notes API responded ${response.status}: ${text}`);
  }
}

// ─── POST a GHL API: agregar múltiples tags al contacto en una sola llamada ──

export async function addContactTags(
  contactId: string,
  bearerToken: string,
  tags: string[],
): Promise<void> {
  if (!tags.length) return;

  const url = `https://services.leadconnectorhq.com/contacts/${contactId}/tags`;
  const requestBody = JSON.stringify({ tags });

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: buildBearerAuth(bearerToken),
        Accept: "application/json",
        "Content-Type": "application/json",
        Version: "2021-07-28",
      },
      body: requestBody,
    },
    GHL_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    console.error(`[GHL addContactTags] ERROR ${response.status}:`, text);
    throw new Error(`GHL tag API responded ${response.status}: ${text}`);
  }
}

// ─── POST a GHL API: crear tag en una location ──────────────────────────────

export async function createLocationTag(
  locationId: string,
  bearerToken: string,
  tagName: string,
): Promise<void> {
  const url = `https://services.leadconnectorhq.com/locations/${locationId}/tags`;
  const requestBody = JSON.stringify({ name: tagName });

  console.log(`[GHL createLocationTag] Creating tag "${tagName}" in location ${locationId}`);

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: buildBearerAuth(bearerToken),
        Accept: "application/json",
        "Content-Type": "application/json",
        Version: "2021-07-28",
      },
      body: requestBody,
    },
    GHL_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    console.warn(`[GHL createLocationTag] Failed to create tag "${tagName}": ${response.status} ${text}`);
  }
}

// ─── Safe wrappers: aplica tag y, si falla, intenta crearlo primero ──────────

export async function safeAddContactTag(
  contactId: string,
  bearerToken: string,
  tag: string,
  locationId?: string | null,
): Promise<void> {
  try {
    await addContactTag(contactId, bearerToken, tag);
  } catch (err) {
    if (locationId) {
      console.warn(`[GHL safeAddContactTag] Tag "${tag}" failed, attempting to create it first`);
      try {
        await createLocationTag(locationId, bearerToken, tag);
      } catch { /* best-effort */ }
      await addContactTag(contactId, bearerToken, tag);
    } else {
      throw err;
    }
  }
}

export async function safeAddContactTags(
  contactId: string,
  bearerToken: string,
  tags: string[],
  locationId?: string | null,
): Promise<void> {
  if (!tags.length) return;

  try {
    await addContactTags(contactId, bearerToken, tags);
  } catch (err) {
    if (locationId) {
      console.warn(`[GHL safeAddContactTags] Bulk tag failed, creating tags individually first`);
      for (const tag of tags) {
        try {
          await createLocationTag(locationId, bearerToken, tag);
        } catch { /* best-effort */ }
      }
      await addContactTags(contactId, bearerToken, tags);
    } else {
      throw err;
    }
  }
}

/**
 * Obtiene los appointments de un contacto en GHL.
 * Retorna el startTime del más cercano a la fecha dada, o null si no hay.
 */
// ─── GHL API: obtener contacto por ID (para assignedTo) ──────────────────────
export async function getContactById(
  contactId: string,
  bearerToken: string,
): Promise<{ assignedTo: string | null } | null> {
  try {
    const token = bearerToken.startsWith("Bearer ") ? bearerToken : `Bearer ${bearerToken}`;
    const res = await fetchWithTimeout(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      {
        method: "GET",
        headers: {
          Authorization: token,
          Accept: "application/json",
          Version: "2021-07-28",
        },
      },
      GHL_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { contact?: { assignedTo?: string } };
    return { assignedTo: data.contact?.assignedTo ?? null };
  } catch {
    return null;
  }
}

export async function getContactAppointmentDate(
  contactId: string,
  bearerToken: string,
  referenceDate: Date,
): Promise<Date | null> {
  try {
    const token = bearerToken.startsWith("Bearer ") ? bearerToken : `Bearer ${bearerToken}`;
    const res = await fetch(
      `https://services.leadconnectorhq.com/contacts/${contactId}/appointments`,
      {
        headers: {
          Authorization: token,
          Version: "2021-07-28",
          "Content-Type": "application/json",
        },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { appointments?: Array<{ startTime?: string }> };
    const appts = data.appointments ?? [];
    if (!appts.length) return null;

    let best: Date | null = null;
    let bestDiff = Infinity;
    for (const a of appts) {
      if (!a.startTime) continue;
      const d = new Date(a.startTime);
      const diff = Math.abs(d.getTime() - referenceDate.getTime());
      if (diff < bestDiff) { bestDiff = diff; best = d; }
    }
    return best;
  } catch {
    return null;
  }
}

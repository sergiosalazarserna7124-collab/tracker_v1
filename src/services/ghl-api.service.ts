import { eq } from "drizzle-orm";
import { drizzleDb } from "../config/drizzle.js";
import { cuentas } from "../db/schema.js";
import { fetchWithTimeout } from "../utils/fetch.utils.js";

const GHL_TIMEOUT_MS = 15_000;

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
} as const;

// ─── Consulta a BD: buscar cuenta por locationid (match exacto) ───────────────

export async function getAccountByLocationId(locationId: string): Promise<CuentaRow | null> {
  const rows = await drizzleDb
    .select({
      id_cuenta: cuentas.id_cuenta,
      nombre_cuenta: cuentas.nombre_cuenta,
      locationid: cuentas.locationid,
      token_ghl: cuentas.token_ghl,
    })
    .from(cuentas)
    .where(eq(cuentas.locationid, locationId))
    .limit(1);

  return rows[0] ?? null;
}

// ─── Consulta a BD: buscar cuenta con datos de Twilio incluidos ──────────────

export async function getAccountFullByLocationId(locationId: string): Promise<CuentaFullRow | null> {
  const rows = await drizzleDb
    .select({
      id_cuenta: cuentas.id_cuenta,
      nombre_cuenta: cuentas.nombre_cuenta,
      locationid: cuentas.locationid,
      token_ghl: cuentas.token_ghl,
      twilio_sid: cuentas.twilio_sid,
      auth_twilio: cuentas.auth_twilio,
    })
    .from(cuentas)
    .where(eq(cuentas.locationid, locationId))
    .limit(1);

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
        Authorization: bearerToken,
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
        Authorization: bearerToken,
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

// ─── POST a GHL API: agregar tag al contacto ──────────────────────────────────
// bearerToken ya incluye el prefijo "Bearer ..." tal como viene en la BD.

export async function addContactTag(
  contactId: string,
  bearerToken: string,
  tag: string,
): Promise<void> {
  const response = await fetchWithTimeout(
    `https://services.leadconnectorhq.com/contacts/${contactId}/tags`,
    {
      method: "POST",
      headers: {
        Authorization: bearerToken,
        Accept: "application/json",
        "Content-Type": "application/json",
        Version: "2021-07-28",
      },
      body: JSON.stringify({ tags: [tag] }),
    },
    GHL_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
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
        Authorization: bearerToken,
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

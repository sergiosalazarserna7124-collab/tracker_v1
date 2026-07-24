import { eq } from "drizzle-orm";
import { drizzleDb } from "../config/drizzle.js";
import { cuentas } from "../db/schema.js";
import { fetchWithTimeout } from "../utils/fetch.utils.js";
import { withRetry } from "../utils/retry.utils.js";

const GHL_TIMEOUT_MS = 15_000;

function isLocationLevelDenied(responseText: string): boolean {
  return /does not have access to this location/i.test(responseText);
}

function throwTokenInvalid(message: string): never {
  const err = new Error(message);
  (err as Error & { isTokenInvalid: boolean }).isTokenInvalid = true;
  throw err;
}

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
  estado_cuenta: string | null;
  ghl_app_uninstalled_at?: Date | null;
  chatbot_transfer_marker?: string | null;
}

export interface CuentaFullRow extends CuentaRow {
  twilio_sid: string | null;
  auth_twilio: string | null;
  openai_api_key: string | null;
  embudo_personalizado: unknown;
  prompt_ventas: string | null;
  prompt_llamadas: string | null;
  reglas_etiquetas: unknown;
  config_llamadas: unknown;
  categorias_llamadas: unknown;
  ghl_opportunity_fields_config: unknown;
  ghl_native_task_workflow: boolean;
  coach_habilitado: boolean;
  gemini_api_key: string | null;
  gemini_premium_status: string | null;
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
  interesado_callai: "interesadocallai",
  no_interesado_callai: "nointeresadocallai",
  agendado_callai: "agendadocallai",
  confirmado_callai: "confirmadocallai",
  perdido: "perdidoautoia",
  descartar: "descartarautoia",
  llamar_despues_callai: "llamardespuescallai",
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
          estado_cuenta: cuentas.estado_cuenta,
          ghl_app_uninstalled_at: cuentas.ghl_app_uninstalled_at,
          chatbot_transfer_marker: cuentas.chatbot_transfer_marker,
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
          estado_cuenta: cuentas.estado_cuenta,
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
          estado_cuenta: cuentas.estado_cuenta,
          twilio_sid: cuentas.twilio_sid,
          auth_twilio: cuentas.auth_twilio,
          openai_api_key: cuentas.openai_api_key,
          embudo_personalizado: cuentas.embudo_personalizado,
          prompt_ventas: cuentas.prompt_ventas,
          prompt_llamadas: cuentas.prompt_llamadas,
          reglas_etiquetas: cuentas.reglas_etiquetas,
          config_llamadas: cuentas.config_llamadas,
          categorias_llamadas: cuentas.categorias_llamadas,
          ghl_opportunity_fields_config: cuentas.ghl_opportunity_fields_config,
          ghl_native_task_workflow: cuentas.ghl_native_task_workflow,
          coach_habilitado: cuentas.coach_habilitado,
          gemini_api_key: cuentas.gemini_api_key,
          gemini_premium_status: cuentas.gemini_premium_status,
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
          estado_cuenta: cuentas.estado_cuenta,
          twilio_sid: cuentas.twilio_sid,
          auth_twilio: cuentas.auth_twilio,
          openai_api_key: cuentas.openai_api_key,
          embudo_personalizado: cuentas.embudo_personalizado,
          prompt_ventas: cuentas.prompt_ventas,
          prompt_llamadas: cuentas.prompt_llamadas,
          reglas_etiquetas: cuentas.reglas_etiquetas,
          config_llamadas: cuentas.config_llamadas,
          categorias_llamadas: cuentas.categorias_llamadas,
          ghl_opportunity_fields_config: cuentas.ghl_opportunity_fields_config,
          ghl_native_task_workflow: cuentas.ghl_native_task_workflow,
          coach_habilitado: cuentas.coach_habilitado,
          gemini_api_key: cuentas.gemini_api_key,
          gemini_premium_status: cuentas.gemini_premium_status,
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

// ─── GHL API: buscar contacto por teléfono en una ubicación ─────────────────

export async function searchContactByPhone(
  locationId: string,
  phone: string,
  bearerToken: string,
): Promise<GhlContact | null> {
  const url = new URL("https://services.leadconnectorhq.com/contacts/");
  url.searchParams.set("locationId", locationId);
  url.searchParams.set("query", phone);

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
    throw new Error(`GHL contacts search (phone) responded ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    contacts?: Array<{
      id: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      assignedTo?: string;
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
    utmContent: null,
  };
}

// ─── GHL API: crear contacto en una ubicación ───────────────────────────────

export interface CreateContactPayload {
  firstName: string;
  lastName?: string;
  phone?: string;
  email?: string;
  customFields?: Array<{ id: string; field_value: string }>;
}

export interface CreateContactResult {
  id: string;
}

export async function createContact(
  locationId: string,
  bearerToken: string,
  payload: CreateContactPayload,
): Promise<CreateContactResult> {
  const body: Record<string, unknown> = {
    locationId,
    firstName: payload.firstName,
  };
  if (payload.lastName) body.lastName = payload.lastName;
  if (payload.phone) body.phone = payload.phone;
  if (payload.email) body.email = payload.email;
  if (payload.customFields?.length) body.customFields = payload.customFields;

  const response = await fetchWithTimeout(
    "https://services.leadconnectorhq.com/contacts/",
    {
      method: "POST",
      headers: {
        Authorization: buildBearerAuth(bearerToken),
        Accept: "application/json",
        "Content-Type": "application/json",
        Version: "2021-07-28",
      },
      body: JSON.stringify(body),
    },
    GHL_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401) {
      throwTokenInvalid(`GHL_TOKEN_INVALID: create contact API 401`);
    }
    if (response.status === 403 && isLocationLevelDenied(text)) {
      throwTokenInvalid(`GHL_TOKEN_INVALID: create contact API 403 location-level denial`);
    }
    throw new Error(`GHL create contact API responded ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { contact?: { id: string } };
  const contactId = data.contact?.id;
  if (!contactId) {
    throw new Error("GHL create contact: response missing contact.id");
  }

  return { id: contactId };
}

// ─── PUT a GHL API: actualizar custom fields de un contacto ─────────────────

export async function updateContactCustomFields(
  contactId: string,
  bearerToken: string,
  customFields: Array<{ key: string; field_value: string }>,
): Promise<void> {
  const response = await fetchWithTimeout(
    `https://services.leadconnectorhq.com/contacts/${contactId}`,
    {
      method: "PUT",
      headers: {
        Authorization: buildBearerAuth(bearerToken),
        Accept: "application/json",
        "Content-Type": "application/json",
        Version: "2021-07-28",
      },
      body: JSON.stringify({ customFields }),
    },
    GHL_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401) {
      throwTokenInvalid(`GHL_TOKEN_INVALID: update contact custom fields API 401`);
    }
    if (response.status === 403 && isLocationLevelDenied(text)) {
      throwTokenInvalid(`GHL_TOKEN_INVALID: update contact custom fields API 403 location-level denial`);
    }
    throw new Error(`GHL update contact custom fields API responded ${response.status}: ${text}`);
  }
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
  console.log("[GHL addContactTag] Headers:", JSON.stringify({ ...headers, Authorization: "Bearer [REDACTED]" }, null, 2));
  console.log("[GHL addContactTag] Body   :", requestBody);
  console.log("[GHL addContactTag] ─────────────────────────────────────────");

  const response = await fetchWithTimeout(url, { method: "POST", headers, body: requestBody }, GHL_TIMEOUT_MS);

  console.log("[GHL addContactTag] Response status:", response.status);

  if (!response.ok) {
    const text = await response.text();
    console.error("[GHL addContactTag] ERROR response body:", text);
    if (response.status === 401) {
      throwTokenInvalid(`GHL_TOKEN_INVALID: tag API 401`);
    }
    if (response.status === 403 && isLocationLevelDenied(text)) {
      throwTokenInvalid(`GHL_TOKEN_INVALID: tag API 403 location-level denial`);
    }
    throw new Error(`GHL tag API responded ${response.status}: ${text}`);
  }
}

// ─── DELETE a GHL API: quitar tag del contacto ───────────────────────────────

export async function removeContactTag(
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

  const response = await fetchWithTimeout(url, { method: "DELETE", headers, body: requestBody }, GHL_TIMEOUT_MS);

  if (!response.ok) {
    const text = await response.text();
    console.error(`[GHL removeContactTag] ERROR ${response.status} removing tag "${tag}" from contact ${contactId}:`, text);
    if (response.status === 401) {
      throwTokenInvalid(`GHL_TOKEN_INVALID: remove tag API 401`);
    }
    if (response.status === 403 && isLocationLevelDenied(text)) {
      throwTokenInvalid(`GHL_TOKEN_INVALID: remove tag API 403 location-level denial`);
    }
    // Best-effort: no lanzar error si el tag ya no existía (404)
    if (response.status !== 404) {
      throw new Error(`GHL remove tag API responded ${response.status}: ${text}`);
    }
  } else {
    console.info(`[GHL removeContactTag] Removed tag "${tag}" from contact ${contactId}`);
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
    if (response.status === 401) {
      throwTokenInvalid(`GHL_TOKEN_INVALID: notes API 401 for contact=${contactId}`);
    }
    if (response.status === 403) {
      if (isLocationLevelDenied(text)) {
        throwTokenInvalid(`GHL_TOKEN_INVALID: notes API 403 location-level denial for contact=${contactId}`);
      }
      throw new Error(`GHL_CONTACT_NOT_ACCESSIBLE: notes API 403 for contact=${contactId}: ${text}`);
    }
    // 400 "Contact not found" = contact was deleted from GHL. Also permanent —
    // treat the same as 403 so speed-to-lead cron does not retry forever.
    if (response.status === 400 && text.toLowerCase().includes("contact not found")) {
      throw new Error(`GHL_CONTACT_NOT_ACCESSIBLE: notes API 400 contact deleted contact=${contactId}: ${text}`);
    }
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
    if (response.status === 401) {
      throwTokenInvalid(`GHL_TOKEN_INVALID: tags API 401`);
    }
    if (response.status === 403 && isLocationLevelDenied(text)) {
      throwTokenInvalid(`GHL_TOKEN_INVALID: tags API 403 location-level denial`);
    }
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
  const validTags = tags.filter((t) => t.trim() !== "");
  if (!validTags.length) return;

  try {
    await addContactTags(contactId, bearerToken, validTags);
  } catch (err) {
    if (locationId) {
      console.warn(`[GHL safeAddContactTags] Bulk tag failed, creating tags individually first`);
      for (const tag of validTags) {
        try {
          await createLocationTag(locationId, bearerToken, tag);
        } catch { /* best-effort */ }
      }
      await addContactTags(contactId, bearerToken, validTags);
    } else {
      throw err;
    }
  }
}

/**
 * Obtiene los appointments de un contacto en GHL.
 * Retorna el startTime del más cercano a la fecha dada, o null si no hay.
 */
// ─── GHL API: obtener contacto por ID (para assignedTo + customFields) ──────
export interface GhlCustomField {
  id: string;
  key: string;
  value: string;
}

export async function getContactById(
  contactId: string,
  bearerToken: string,
): Promise<{ assignedTo: string | null; tags: string[]; customFields?: GhlCustomField[] } | null> {
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
    const data = (await res.json()) as {
      contact?: {
        assignedTo?: string;
        tags?: string[];
        customFields?: Array<{ id: string; key?: string; value?: string; field_value?: string }>;
      };
    };
    const rawFields = data.contact?.customFields;
    const customFields: GhlCustomField[] | undefined = rawFields?.map((f) => ({
      id: f.id,
      key: f.key ?? f.id,
      value: f.value ?? f.field_value ?? "",
    }));
    return {
      assignedTo: data.contact?.assignedTo ?? null,
      tags: data.contact?.tags ?? [],
      customFields,
    };
  } catch {
    return null;
  }
}

export async function contactHasTag(
  contactId: string,
  bearerToken: string,
  tag: string,
): Promise<boolean> {
  const contact = await getContactById(contactId, bearerToken);
  return contact?.tags.includes(tag) ?? false;
}

export async function getContactAppointmentDate(
  contactId: string,
  bearerToken: string,
  referenceDate: Date,
): Promise<Date | null> {
  const result = await getContactAppointmentInfo(contactId, bearerToken, referenceDate);
  return result?.date ?? null;
}

/**
 * Obtiene fecha Y dueño (assignedUserId) de la cita más relevante de un contacto.
 * GHL distingue entre el dueño del CONTACTO (contact.assignedTo) y el dueño de la CITA
 * (appointment.assignedUserId) — pueden ser personas distintas (ej: setter vs closer).
 */
export async function getContactAppointmentInfo(
  contactId: string,
  bearerToken: string,
  referenceDate: Date,
): Promise<{ date: Date; assignedUserId: string | null } | null> {
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
    // GHL API returns "events" (not "appointments") — field name mismatch was causing null returns
    const data = (await res.json()) as {
      events?: Array<{ startTime?: string; appointmentStatus?: string; deleted?: boolean; assignedUserId?: string }>;
      appointments?: Array<{ startTime?: string; appointmentStatus?: string; deleted?: boolean; assignedUserId?: string }>;
    };
    const appts = (data.events ?? data.appointments ?? []).filter(
      (a) => a.startTime && !a.deleted,
    );
    if (!appts.length) return null;

    // Strategy: prefer upcoming confirmed appointments first.
    // Only fall back to nearest-to-referenceDate if no future confirmed exists.
    // This prevents picking a past/cancelled appointment when there's a real upcoming one.
    const TERMINAL_STATUSES = new Set(["noshow", "no-show", "cancelled", "canceled"]);

    const futureConfirmed = appts.filter((a) => {
      const d = new Date(a.startTime!);
      const status = (a.appointmentStatus ?? "").toLowerCase();
      return d >= referenceDate && !TERMINAL_STATUSES.has(status);
    });

    if (futureConfirmed.length > 0) {
      const best = futureConfirmed.reduce((earliest, a) => {
        const d = new Date(a.startTime!);
        return d < new Date(earliest.startTime!) ? a : earliest;
      }, futureConfirmed[0]);
      return { date: new Date(best.startTime!), assignedUserId: best.assignedUserId ?? null };
    }

    // No future confirmed — fall back to the appointment closest to referenceDate
    let bestAppt: typeof appts[0] | null = null;
    let bestDiff = Infinity;
    for (const a of appts) {
      const d = new Date(a.startTime!);
      const diff = Math.abs(d.getTime() - referenceDate.getTime());
      if (diff < bestDiff) { bestDiff = diff; bestAppt = a; }
    }
    if (!bestAppt) return null;
    return { date: new Date(bestAppt.startTime!), assignedUserId: bestAppt.assignedUserId ?? null };
  } catch {
    return null;
  }
}

// ─── GHL API: buscar opportunity de un contacto ───────────────────────────────

export async function searchOpportunityByContact(
  contactId: string,
  locationId: string,
  bearerToken: string,
): Promise<string | null> {
  try {
    const url = new URL("https://services.leadconnectorhq.com/opportunities/search");
    url.searchParams.set("contact_id", contactId);
    url.searchParams.set("location_id", locationId);

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
      console.warn(`[GHL searchOpportunityByContact] ${response.status}: ${text}`);
      return null;
    }

    const data = (await response.json()) as {
      opportunities?: Array<{ id: string }>;
    };

    return data.opportunities?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

// ─── GHL API: actualizar stage de un opportunity ─────────────────────────────

export async function updateOpportunityStage(
  opportunityId: string,
  stageId: string,
  bearerToken: string,
): Promise<void> {
  const response = await fetchWithTimeout(
    `https://services.leadconnectorhq.com/opportunities/${opportunityId}`,
    {
      method: "PUT",
      headers: {
        Authorization: buildBearerAuth(bearerToken),
        Accept: "application/json",
        "Content-Type": "application/json",
        Version: "2021-07-28",
      },
      body: JSON.stringify({ stageId }),
    },
    GHL_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GHL opportunity update responded ${response.status}: ${text}`);
  }
}

// ─── GHL API: actualizar custom fields de un opportunity ────────────────────

export async function updateOpportunityCustomFields(
  opportunityId: string,
  bearerToken: string,
  customFields: Array<{ id: string; field_value: string }>,
): Promise<void> {
  const response = await fetchWithTimeout(
    `https://services.leadconnectorhq.com/opportunities/${opportunityId}`,
    {
      method: "PUT",
      headers: {
        Authorization: buildBearerAuth(bearerToken),
        Accept: "application/json",
        "Content-Type": "application/json",
        Version: "2021-07-28",
      },
      body: JSON.stringify({ customFields }),
    },
    GHL_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GHL opportunity custom fields update responded ${response.status}: ${text}`);
  }
}

// ─── GHL API: leer custom fields de un opportunity ──────────────────────────

export async function getOpportunityById(
  opportunityId: string,
  bearerToken: string,
): Promise<{ customFields?: Array<{ id: string; fieldValue?: string }> } | null> {
  try {
    const response = await fetchWithTimeout(
      `https://services.leadconnectorhq.com/opportunities/${opportunityId}`,
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
      console.warn(`[GHL getOpportunityById] ${response.status}: ${text}`);
      return null;
    }

    const data = (await response.json()) as { opportunity?: { customFields?: Array<{ id: string; fieldValue?: string }> } };
    return data.opportunity ?? null;
  } catch {
    return null;
  }
}

// ─── GHL API: listar custom fields de una location ─────────────────────────

export interface GhlCustomFieldDefinition {
  id: string;
  name: string;
  fieldKey: string;
  dataType: string;
}

export async function getLocationCustomFields(
  locationId: string,
  bearerToken: string,
): Promise<GhlCustomFieldDefinition[]> {
  const url = `https://services.leadconnectorhq.com/locations/${locationId}/customFields`;

  const response = await fetchWithTimeout(
    url,
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
    throw new Error(`GHL list custom fields responded ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    customFields?: Array<{ id: string; name?: string; fieldKey?: string; dataType?: string }>;
  };

  return (data.customFields ?? []).map((f) => ({
    id: f.id,
    name: f.name ?? "",
    fieldKey: f.fieldKey ?? "",
    dataType: f.dataType ?? "TEXT",
  }));
}

// ─── GHL API: crear custom field en una location ────────────────────────────

export async function createLocationCustomField(
  locationId: string,
  bearerToken: string,
  field: { name: string; dataType?: string },
): Promise<GhlCustomFieldDefinition> {
  const url = `https://services.leadconnectorhq.com/locations/${locationId}/customFields`;
  const body = {
    name: field.name,
    dataType: field.dataType ?? "TEXT",
    model: "contact",
  };

  console.log(`[GHL createLocationCustomField] Creating field "${field.name}" (${body.dataType}) in location ${locationId}`);

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
      body: JSON.stringify(body),
    },
    GHL_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401) {
      throwTokenInvalid(`GHL_TOKEN_INVALID: create custom field API 401`);
    }
    if (response.status === 403 && isLocationLevelDenied(text)) {
      throwTokenInvalid(`GHL_TOKEN_INVALID: create custom field API 403 location-level denial`);
    }
    throw new Error(`GHL create custom field API responded ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    customField?: { id: string; name?: string; fieldKey?: string; dataType?: string };
  };

  const cf = data.customField;
  if (!cf?.id) {
    throw new Error("GHL create custom field: response missing customField.id");
  }

  console.log(`[GHL createLocationCustomField] Created field "${field.name}" → id=${cf.id} key=${cf.fieldKey}`);

  return {
    id: cf.id,
    name: cf.name ?? field.name,
    fieldKey: cf.fieldKey ?? "",
    dataType: cf.dataType ?? body.dataType,
  };
}

// ─── GHL API: ensure custom field exists (idempotent) ───────────────────────
// Checks if a field with the given key exists; creates it if not.
// Returns the field's key (fieldKey) for use in updateContactCustomFields.

const _customFieldCache = new Map<string, Map<string, GhlCustomFieldDefinition>>();

export async function ensureCustomField(
  locationId: string,
  bearerToken: string,
  field: { key: string; name: string; dataType?: string },
): Promise<string> {
  const cacheKey = `${locationId}`;
  let locationCache = _customFieldCache.get(cacheKey);

  const cachedHit = locationCache?.get(field.key);
  if (cachedHit) {
    return cachedHit.fieldKey;
  }

  if (!locationCache) {
    try {
      const existing = await getLocationCustomFields(locationId, bearerToken);
      locationCache = new Map<string, GhlCustomFieldDefinition>();
      for (const f of existing) {
        locationCache.set(f.fieldKey, f);
      }
      _customFieldCache.set(cacheKey, locationCache);
    } catch (err) {
      console.warn(`[GHL ensureCustomField] Failed to list fields for location ${locationId}:`, err);
      return field.key;
    }
  }

  const existingHit = locationCache.get(field.key);
  if (existingHit) {
    return existingHit.fieldKey;
  }

  const byName = [...locationCache.values()].find(
    (f) => f.name.toLowerCase() === field.name.toLowerCase(),
  );
  if (byName) {
    locationCache.set(field.key, byName);
    return byName.fieldKey;
  }

  try {
    const created = await createLocationCustomField(locationId, bearerToken, {
      name: field.name,
      dataType: field.dataType ?? "TEXT",
    });
    locationCache.set(created.fieldKey, created);
    return created.fieldKey;
  } catch (err) {
    console.warn(`[GHL ensureCustomField] Failed to create field "${field.name}" — will attempt write anyway:`, err);
    return field.key;
  }
}

// ─── GHL API: crear tarea en un contacto ───────────────────────────────────

export interface CreateContactTaskPayload {
  title: string;
  body?: string;
  dueDate: string;
  completed?: boolean;
  assignedTo?: string;
}

export async function createContactTask(
  contactId: string,
  bearerToken: string,
  task: CreateContactTaskPayload,
): Promise<{ id: string } | null> {
  const payload: Record<string, unknown> = {
    title: task.title,
    dueDate: task.dueDate,
    completed: task.completed ?? false,
  };
  if (task.body) payload.body = task.body;
  if (task.assignedTo) payload.assignedTo = task.assignedTo;

  try {
    const response = await fetchWithTimeout(
      `https://services.leadconnectorhq.com/contacts/${contactId}/tasks`,
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
      if (response.status === 401) {
        throwTokenInvalid(`GHL_TOKEN_INVALID: create task API 401`);
      }
      if (response.status === 403 && isLocationLevelDenied(text)) {
        throwTokenInvalid(`GHL_TOKEN_INVALID: create task API 403 location-level denial`);
      }
      console.error(`[GHL createContactTask] ${response.status}: ${text}`);
      return null;
    }

    const data = (await response.json()) as { task?: { id: string } };
    return data.task?.id ? { id: data.task.id } : null;
  } catch (err) {
    const isTokenInvalid = (err as Error & { isTokenInvalid?: boolean }).isTokenInvalid;
    if (isTokenInvalid) throw err;
    console.error(`[GHL createContactTask] Error (best-effort):`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Helper: extraer mapa funnelStage → stageId de embudo_personalizado ──────
// El Admin Panel configura embudo_personalizado.funnel_stage_map como un objeto
// { "nombre_funnelStage": "stageId_ghl" } para cada cuenta.

export function parseFunnelStageMap(embudoPersonalizado: unknown): Record<string, string> {
  if (typeof embudoPersonalizado !== "object" || embudoPersonalizado === null) {
    return {};
  }
  const obj = embudoPersonalizado as Record<string, unknown>;
  const raw = obj["funnel_stage_map"];
  if (typeof raw !== "object" || raw === null) return {};
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === "string") result[key] = val;
  }
  return result;
}

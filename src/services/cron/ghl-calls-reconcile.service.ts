/**
 * Reconciliación de llamadas GHL (marketplace).
 *
 * GHL NO dispara el webhook OutboundMessage para llamadas no contestadas
 * (no-answer / busy / voicemail) — solo para completed y failed. Limitación
 * conocida de la plataforma (feature request abierto: "OutboundMessage
 * Webhook should fire for all Call Status"). Los workflows nativos sí ven
 * todos los estados, por eso los webhooks manuales las traían y la app no.
 *
 * Este job barre, por cada location instalada y vinculada a una cuenta, las
 * conversaciones con actividad reciente vía API de GHL, encuentra los
 * mensajes TYPE_CALL que nunca llegaron por webhook (no existen en
 * log_llamadas por call_sid) y los procesa por el MISMO pipeline que el
 * webhook real (handleMarketplaceEvent → handleCallEvent), así el resultado
 * es idéntico: log_llamadas + salida de "pendientes" + transcript/IA si aplica.
 *
 * Corre en dos modos:
 *  - Loop interno cada GHL_CALLS_RECONCILE_MIN minutos (default 5; 0 = off).
 *  - POST /cron/ghl-calls-reconcile (x-cron-secret) para disparo manual/backfill.
 */

import { db as pgPool } from "../../config/database.js";
import { getAccountByLocationId } from "../ghl-api.service.js";
import { getAccessToken } from "../../services/oauth/ghl-oauth.service.js";
import { handleMarketplaceEvent } from "../webhooks/ghl-marketplace.service.js";

const GHL_API = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-04-15";

/** Ventana por defecto: cuánto hacia atrás buscar llamadas sin registrar. */
const DEFAULT_LOOKBACK_HOURS = 24;
/** Máximo de conversaciones recientes a revisar por location en cada corrida. */
const MAX_CONVERSATIONS = 50;
/** Máximo de mensajes por conversación (los más recientes). */
const MESSAGES_LIMIT = 20;

interface GhlConversation {
  id: string;
  contactId?: string;
  lastMessageDate?: number;
}

interface GhlCallMeta {
  call?: { duration?: number | null; status?: string | null };
}

interface GhlMessage {
  id: string;
  messageType?: string;
  type?: number;
  status?: string | null;
  direction?: string;
  locationId?: string;
  contactId?: string;
  userId?: string | null;
  from?: string;
  to?: string;
  dateAdded?: string;
  meta?: GhlCallMeta;
}

export interface ReconcileResult {
  locations: number;
  conversations: number;
  callsSeen: number;
  processed: number;
  errors: string[];
}

async function ghlGet<T>(path: string, token: string): Promise<T | null> {
  const res = await fetch(`${GHL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GHL GET ${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Locations con token OAuth propio (instaladas vía marketplace app). */
async function getInstalledLocationIds(): Promise<string[]> {
  const { rows } = await pgPool.query<{ location_id: string }>(
    `SELECT DISTINCT location_id FROM ghl_oauth_tokens WHERE location_id IS NOT NULL`,
  );
  return rows.map((r) => r.location_id);
}

async function reconcileLocation(
  locationId: string,
  since: Date,
  result: ReconcileResult,
): Promise<void> {
  const account = await getAccountByLocationId(locationId);
  if (!account) return; // location instalada pero sin cuenta vinculada → nada que trackear
  const token = await getAccessToken(locationId);
  if (!token) return;

  result.locations += 1;
  const sinceMs = since.getTime();

  const search = await ghlGet<{ conversations?: GhlConversation[] }>(
    `/conversations/search?locationId=${encodeURIComponent(locationId)}` +
      `&sortBy=last_message_date&sort=desc&limit=${MAX_CONVERSATIONS}`,
    token,
  );
  const recent = (search?.conversations ?? []).filter(
    (c) => (c.lastMessageDate ?? 0) >= sinceMs,
  );

  for (const conv of recent) {
    result.conversations += 1;
    const data = await ghlGet<{ messages?: { messages?: GhlMessage[] } | GhlMessage[] }>(
      `/conversations/${conv.id}/messages?limit=${MESSAGES_LIMIT}`,
      token,
    );
    const raw = data?.messages;
    const msgs: GhlMessage[] = Array.isArray(raw) ? raw : (raw?.messages ?? []);

    const calls = msgs.filter(
      (m) =>
        (m.messageType ?? "").toUpperCase().includes("CALL") &&
        m.id &&
        m.dateAdded &&
        new Date(m.dateAdded).getTime() >= sinceMs,
    );
    if (calls.length === 0) continue;
    result.callsSeen += calls.length;

    // Solo las que el webhook nunca trajo (no existen por call_sid).
    const { rows: existing } = await pgPool.query<{ call_sid: string }>(
      `SELECT call_sid FROM log_llamadas WHERE id_cuenta = $1 AND call_sid = ANY($2)`,
      [account.id_cuenta, calls.map((c) => c.id)],
    );
    const known = new Set(existing.map((r) => r.call_sid));

    for (const call of calls) {
      if (known.has(call.id)) continue;
      const status = call.status ?? call.meta?.call?.status ?? null;
      try {
        await handleMarketplaceEvent(
          call.direction === "inbound" ? "InboundMessage" : "OutboundMessage",
          {
            messageType: "CALL",
            locationId: call.locationId ?? locationId,
            contactId: call.contactId ?? conv.contactId,
            messageId: call.id,
            status,
            callStatus: call.meta?.call?.status ?? null,
            callDuration: call.meta?.call?.duration ?? null,
            direction: call.direction,
            userId: call.userId ?? null,
            from: call.from,
            to: call.to,
            dateAdded: call.dateAdded,
          },
        );
        result.processed += 1;
        console.info(
          `[GhlCallsReconcile] recuperada llamada sin webhook: location=${locationId} contacto=${call.contactId ?? conv.contactId} status=${status} sid=${call.id}`,
        );
      } catch (e) {
        result.errors.push(`${locationId}/${call.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

export async function runGhlCallsReconcile(lookbackHours?: number): Promise<ReconcileResult> {
  const hours = lookbackHours && lookbackHours > 0 ? lookbackHours : DEFAULT_LOOKBACK_HOURS;
  const since = new Date(Date.now() - hours * 3_600_000);
  const result: ReconcileResult = { locations: 0, conversations: 0, callsSeen: 0, processed: 0, errors: [] };

  const locationIds = await getInstalledLocationIds();
  for (const locationId of locationIds) {
    try {
      await reconcileLocation(locationId, since, result);
    } catch (e) {
      result.errors.push(`${locationId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (result.processed > 0 || result.errors.length > 0) {
    console.info(
      `[GhlCallsReconcile] locations=${result.locations} convs=${result.conversations} ` +
        `llamadas=${result.callsSeen} recuperadas=${result.processed} errores=${result.errors.length}`,
    );
  }
  return result;
}

// ─── Loop interno ─────────────────────────────────────────────────────────────
// Las llamadas no contestadas NO pueden esperar a que alguien agende un cron
// externo: el propio backend se auto-programa. En cada tick reconcilia con una
// ventana corta (2h) — el endpoint /cron permite backfills más largos.

let running = false;

export function startGhlCallsReconcileLoop(intervalMinutes: number): NodeJS.Timeout | null {
  if (!intervalMinutes || intervalMinutes <= 0) return null;
  const timer = setInterval(() => {
    if (running) return; // no solapar corridas si una se demora
    running = true;
    runGhlCallsReconcile(2)
      .catch((e) => console.error("[GhlCallsReconcile] tick falló:", e instanceof Error ? e.message : e))
      .finally(() => { running = false; });
  }, intervalMinutes * 60_000);
  timer.unref(); // no impedir el shutdown del proceso
  console.info(`[GhlCallsReconcile] loop interno activo cada ${intervalMinutes} min`);
  return timer;
}

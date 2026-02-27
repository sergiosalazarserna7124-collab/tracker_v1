// ─── Twilio REST API wrapper ──────────────────────────────────────────────────
// Todas las llamadas usan Basic Auth: base64(twilioSid:authToken)

import { fetchWithTimeout } from "../utils/fetch.utils.js";

// 30s para metadata: el primer request desde Cloud Run puede tardar
// por resolución DNS fría + TLS handshake a api.twilio.com.
const TWILIO_METADATA_TIMEOUT_MS = 30_000;
const TWILIO_DOWNLOAD_TIMEOUT_MS = 90_000;

// Polling config: Twilio puede tardar segundos en publicar el recording
// después de que la llamada termina. En vez de un sleep fijo, hacemos
// polling con backoff para salir tan pronto como esté disponible.
const RECORDING_POLL_ATTEMPTS = 3;
const RECORDING_POLL_DELAYS_MS = [0, 4_000, 8_000]; // inmediato, 4s, 8s

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function basicAuthHeader(sid: string, token: string): string {
  return `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
}

const TWILIO_BASE = "https://api.twilio.com/2010-04-01/Accounts";

// ─── 1. Buscar la última llamada completada al número dado ───────────────────

export interface TwilioCall {
  callSid: string;
  accountSid: string;
  parentCallSid: string | null;
}

export async function getLatestCompletedCall(
  twilioSid: string,
  authToken: string,
  phoneNumber: string,
): Promise<TwilioCall | null> {
  const url = new URL(`${TWILIO_BASE}/${twilioSid}/Calls.json`);
  url.searchParams.set("To", phoneNumber);
  url.searchParams.set("Status", "completed");
  url.searchParams.set("PageSize", "1");

  const response = await fetchWithTimeout(
    url.toString(),
    {
      method: "GET",
      headers: {
        Authorization: basicAuthHeader(twilioSid, authToken),
        Version: "2021-07-28",
      },
    },
    TWILIO_METADATA_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twilio Calls API responded ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    calls?: Array<{ sid?: string; account_sid?: string; parent_call_sid?: string }>;
  };

  const call = data.calls?.[0];
  if (!call?.sid || !call?.account_sid) return null;

  return {
    callSid: call.sid,
    accountSid: call.account_sid,
    parentCallSid: call.parent_call_sid ?? null,
  };
}

// ─── 2. Obtener el recording SID de una llamada ─────────────────────────────
// GHL usa arquitectura de conferencia: la grabación puede estar en el callSid
// principal O en el parentCallSid. Se intenta el principal primero; si devuelve
// vacío y existe un parentCallSid, se reintenta con él.

async function fetchRecordingSid(
  accountSid: string,
  targetCallSid: string,
  twilioSid: string,
  authToken: string,
): Promise<string | null> {
  const url = `${TWILIO_BASE}/${accountSid}/Calls/${targetCallSid}/Recordings.json`;

  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        Authorization: basicAuthHeader(twilioSid, authToken),
      },
    },
    TWILIO_METADATA_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twilio Recordings list API responded ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    recordings?: Array<{ sid?: string }>;
  };

  return data.recordings?.[0]?.sid ?? null;
}

export async function getCallRecordingSid(
  accountSid: string,
  callSid: string,
  twilioSid: string,
  authToken: string,
  parentCallSid?: string | null,
): Promise<string | null> {
  const sidsToTry = [callSid];
  if (parentCallSid && parentCallSid !== callSid) {
    sidsToTry.push(parentCallSid);
  }

  // Polling con backoff: para cada intento, probamos primero callSid
  // y luego parentCallSid. Si ninguno tiene recording, esperamos y
  // reintentamos. Twilio puede tardar segundos en publicar la grabación.
  for (let attempt = 0; attempt < RECORDING_POLL_ATTEMPTS; attempt++) {
    const delay = RECORDING_POLL_DELAYS_MS[attempt] ?? 8_000;
    if (delay > 0) {
      console.log(
        `[Twilio] Recording no disponible aún (intento ${attempt}/${RECORDING_POLL_ATTEMPTS}); esperando ${delay}ms…`,
      );
      await sleep(delay);
    }

    for (const sid of sidsToTry) {
      const label = sid === callSid ? "callSid" : "parentCallSid";
      try {
        const recSid = await fetchRecordingSid(accountSid, sid, twilioSid, authToken);
        if (recSid) {
          if (attempt > 0 || sid !== callSid) {
            console.log(
              `[Twilio] Recording encontrado en ${label}="${sid}" (intento ${attempt + 1})`,
            );
          }
          return recSid;
        }
      } catch (err) {
        console.warn(`[Twilio] Error buscando recording en ${label}="${sid}":`, err);
      }
    }
  }

  console.warn(
    `[Twilio] Sin recordings después de ${RECORDING_POLL_ATTEMPTS} intentos para callSid="${callSid}"${parentCallSid ? ` / parentCallSid="${parentCallSid}"` : ""}`,
  );
  return null;
}

// ─── 3. Descargar el audio mp3 de un recording ──────────────────────────────

export async function downloadRecording(
  accountSid: string,
  recordingSid: string,
  twilioSid: string,
  authToken: string,
): Promise<Buffer | null> {
  const url = `${TWILIO_BASE}/${accountSid}/Recordings/${recordingSid}.mp3`;

  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        Authorization: basicAuthHeader(twilioSid, authToken),
      },
    },
    TWILIO_DOWNLOAD_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twilio Recording download responded ${response.status}: ${text}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

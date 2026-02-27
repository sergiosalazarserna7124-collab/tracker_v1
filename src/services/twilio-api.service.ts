// ─── Twilio REST API wrapper ──────────────────────────────────────────────────
// Todas las llamadas usan Basic Auth: base64(twilioSid:authToken)

import { fetchWithTimeout } from "../utils/fetch.utils.js";

const TWILIO_METADATA_TIMEOUT_MS = 15_000;
const TWILIO_DOWNLOAD_TIMEOUT_MS = 90_000;

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
  // Intento 1: callSid principal
  const sid = await fetchRecordingSid(accountSid, callSid, twilioSid, authToken);
  if (sid) return sid;

  // Intento 2: parentCallSid como fallback (patrón frecuente en GHL/conferencias)
  if (parentCallSid && parentCallSid !== callSid) {
    console.log(
      `[Twilio] Sin recordings en callSid="${callSid}"; reintentando con parentCallSid="${parentCallSid}"`,
    );
    return fetchRecordingSid(accountSid, parentCallSid, twilioSid, authToken);
  }

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

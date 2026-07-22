import pg from "pg";

const CEREBRO_URL =
  process.env.CEREBRO_URL ??
  "https://cerebro-tracker-v6-saas-git-cstkjl7bpa-ue.a.run.app";
const DEMO_ACCOUNT_ID = 52;
const DEMO_LOCATION_ID = "QfAM4c37M8mR2xBxqJaJ";
const DB_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://agente_readonly:readonly_autokpi_2026@mainbd.automatizacionesia.com:5432/postgres";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: DB_URL,
      max: 3,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export function uid(): string {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface WebhookResult {
  status: number;
  body: unknown;
}

export async function sendChatWebhook(opts: {
  messageBody?: string;
  direction?: "inbound" | "outbound";
  contactId?: string;
  conversationId?: string;
  contactName?: string;
}): Promise<WebhookResult & { contactId: string; conversationId: string }> {
  const contactId = opts.contactId ?? uid();
  const conversationId = opts.conversationId ?? uid();
  const payload = {
    type: "InboundMessage",
    contentType: "text/plain",
    status: "delivered",
    locationId: DEMO_LOCATION_ID,
    conversationId,
    contactId,
    direction: opts.direction ?? "inbound",
    messageType: "TYPE_WHATSAPP",
    body:
      opts.messageBody ??
      "Hola, quiero saber más sobre el servicio de tracking.",
    dateAdded: new Date().toISOString(),
    id: uid(),
    contact: {
      id: contactId,
      name: opts.contactName ?? "E2E Golden Lead",
      firstName: "E2E",
      lastName: "GoldenLead",
      phone: "+5215500000001",
      email: `${contactId}@e2e.autokpi.net`,
    },
  };

  const res = await fetch(`${CEREBRO_URL}/webhooks/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return {
    status: res.status,
    body: await res.json().catch(() => null),
    contactId,
    conversationId,
  };
}

export async function sendCallWebhook(opts?: {
  transcript?: string;
  estado?: string;
  callId?: string;
  phone?: string;
  brokerName?: string;
}): Promise<WebhookResult & { callId: string }> {
  const vozSecret = process.env.VOZ_WEBHOOK_SECRET;
  if (!vozSecret) {
    throw new Error(
      "VOZ_WEBHOOK_SECRET requerido para enviar webhooks de voz",
    );
  }

  const callId = opts?.callId ?? uid();
  const payload = {
    event: "call.completed",
    call_id: callId,
    accountid: DEMO_ACCOUNT_ID,
    estado: opts?.estado ?? "interesado",
    phone: opts?.phone ?? "+5215500000002",
    transcript:
      opts?.transcript ??
      "Vendedor: Hola buenas tardes. Cliente: Sí dígame. Vendedor: Le llamo de AutoKPI. Cliente: Suena bien, agéndeme.",
    short_summary: "E2E test call",
    ended_at: new Date().toISOString(),
    duration_seconds: 180,
    broker_name: opts?.brokerName ?? "E2E Closer",
    broker_company: "AutoKPI Demo",
  };

  const res = await fetch(`${CEREBRO_URL}/webhooks/voz`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-voz-secret": vozSecret,
    },
    body: JSON.stringify(payload),
  });

  return {
    status: res.status,
    body: await res.json().catch(() => null),
    callId,
  };
}

export async function sendVideocallWebhook(opts?: {
  title?: string;
  recordingId?: string;
  inviteeEmail?: string;
  inviteeName?: string;
}): Promise<WebhookResult & { recordingId: string }> {
  const recordingId = opts?.recordingId ?? String(Date.now());
  const now = new Date().toISOString();

  const payload = {
    recording_id: Number(recordingId) || Date.now(),
    share_url: `https://fathom.video/share/e2e-${recordingId}`,
    title: opts?.title ?? "E2E Golden Videocall",
    created_at: now,
    scheduled_start_time: now,
    scheduled_end_time: now,
    recording_start_time: now,
    recording_end_time: now,
    recorded_by: {
      email: "closer-demo@autokpi.net",
      name: "Demo Closer",
      email_domain: "autokpi.net",
    },
    calendar_invitees: [
      {
        email: "closer-demo@autokpi.net",
        is_external: false,
        name: "Demo Closer",
        matched_speaker_display_name: "Demo Closer",
      },
      {
        email: opts?.inviteeEmail ?? "lead-e2e@example.com",
        is_external: true,
        name: opts?.inviteeName ?? "E2E Lead Golden",
        matched_speaker_display_name: "E2E Lead",
      },
    ],
    transcript: [
      {
        speaker: {
          display_name: "Demo Closer",
          matched_calendar_invitee_email: "closer-demo@autokpi.net",
        },
        text: "Bienvenido a la demo de AutoKPI.",
        timestamp: "00:00:05",
      },
      {
        speaker: {
          display_name: "E2E Lead",
          matched_calendar_invitee_email:
            opts?.inviteeEmail ?? "lead-e2e@example.com",
        },
        text: "Gracias, estoy interesado en el tracking de ventas.",
        timestamp: "00:00:15",
      },
    ],
  };

  const res = await fetch(
    `${CEREBRO_URL}/webhooks/fathom/${DEMO_ACCOUNT_ID}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );

  return {
    status: res.status,
    body: await res.json().catch(() => null),
    recordingId,
  };
}

export async function waitForProcessing(ms = 10_000): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function queryDB<T extends pg.QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params);
  return result.rows;
}

export { DEMO_ACCOUNT_ID, DEMO_LOCATION_ID, CEREBRO_URL };

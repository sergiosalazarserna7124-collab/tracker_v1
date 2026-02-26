/**
 * Detecta y normaliza el formato del payload de un webhook entrante.
 *
 * Soporta dos formatos sin que el remitente necesite hacer cambios:
 *
 *   ① Formato directo (GHL / Fathom / Twilio nativos):
 *        { first_name: "...", customData: { ... } }
 *
 *   ② Formato n8n (array envuelto):
 *        [{ body: { first_name: "...", customData: { ... } }, headers: {...}, ... }]
 *
 * De esta forma el backend es agnóstico al intermediario y la transición
 * de n8n a webhooks directos es transparente.
 */
export function extractWebhookBody<T>(rawBody: unknown): T | null {
  // ── Formato n8n: array de items con campo "body" ──────────────────────────
  if (Array.isArray(rawBody)) {
    const first: unknown = rawBody[0];
    if (!first || typeof first !== "object") return null;

    // n8n añade: { body: {...}, headers: {...}, webhookUrl: "...", ... }
    if ("body" in first) {
      const inner = (first as Record<string, unknown>).body;
      return (inner ?? null) as T | null;
    }

    // Array plano sin wrapper (fallback improbable pero seguro)
    return first as T;
  }

  // ── Formato directo: objeto puro ──────────────────────────────────────────
  if (rawBody && typeof rawBody === "object") {
    return rawBody as T;
  }

  return null;
}

import type { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../../config/database.js";

interface GhlMarketplaceBody {
  type?: string;
  locationId?: string;
  location_id?: string;
  [key: string]: unknown;
}

async function verifyEd25519Signature(
  rawBody: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
): Promise<boolean> {
  if (!signatureHeader || !timestampHeader) return false;

  try {
    const signatureBytes = Buffer.from(signatureHeader, "base64");
    const message = `${timestampHeader}.${rawBody}`;
    const messageBytes = new TextEncoder().encode(message);

    const GHL_WEBHOOK_PUBLIC_KEY = process.env.GHL_WEBHOOK_PUBLIC_KEY ?? "";
    if (!GHL_WEBHOOK_PUBLIC_KEY) return false;

    const keyBytes = Buffer.from(GHL_WEBHOOK_PUBLIC_KEY, "base64");
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );

    return await crypto.subtle.verify("Ed25519", cryptoKey, signatureBytes, messageBytes);
  } catch {
    return false;
  }
}

export async function handleGhlMarketplaceShadow(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.code(200).send({ ok: true });

  try {
    const body = request.body as GhlMarketplaceBody;
    const eventType = body?.type ?? (request.headers["x-ghl-event"] as string | undefined) ?? null;
    const locationId = body?.locationId ?? body?.location_id ?? null;

    const signatureHeader = request.headers["x-ghl-signature"] as string | undefined;
    const timestampHeader = request.headers["x-ghl-timestamp"] as string | undefined;

    let signatureOk: boolean | null = null;
    if (signatureHeader) {
      const rawBody = typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body);
      signatureOk = await verifyEd25519Signature(rawBody, signatureHeader, timestampHeader);
    }

    const headersToStore: Record<string, string> = {};
    for (const key of [
      "x-ghl-signature",
      "x-ghl-timestamp",
      "x-ghl-event",
      "content-type",
      "user-agent",
    ]) {
      const val = request.headers[key];
      if (typeof val === "string") headersToStore[key] = val;
    }

    await db.query(
      `INSERT INTO ghl_marketplace_shadow (event_type, location_id, headers, payload, signature_ok)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        eventType,
        locationId,
        JSON.stringify(headersToStore),
        JSON.stringify(body ?? {}),
        signatureOk,
      ],
    );

    request.log.info(
      `[GHL-Shadow] Evento registrado: type=${eventType ?? "unknown"} location=${locationId ?? "none"} sig=${signatureOk === null ? "no-header" : signatureOk}`,
    );
  } catch (err) {
    request.log.error(
      `[GHL-Shadow] Error guardando evento: ${err instanceof Error ? err.message : err}`,
    );
  }
}

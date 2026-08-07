import type { FastifyRequest, FastifyReply } from "fastify";
import { verify as ed25519Verify } from "node:crypto";
import { db } from "../../config/database.js";
import { provisionLocationFromStoredCompany } from "../../services/oauth/ghl-oauth.service.js";

interface GhlMarketplaceBody {
  type?: string;
  locationId?: string;
  location_id?: string;
  [key: string]: unknown;
}

function verifyGhlSignature(
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader || signatureHeader === "N/A") return false;

  const publicKeyPem = process.env.GHL_WEBHOOK_PUBLIC_KEY ?? "";
  if (!publicKeyPem) return false;

  try {
    const payloadBuffer = Buffer.from(rawBody, "utf8");
    const signatureBuffer = Buffer.from(signatureHeader, "base64");
    return ed25519Verify(null, payloadBuffer, publicKeyPem, signatureBuffer);
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

    let signatureOk: boolean | null = null;
    if (signatureHeader) {
      const rawBody = typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body);
      signatureOk = verifyGhlSignature(rawBody, signatureHeader);
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

    // Opción B: cuando se INSTALA en una location nueva, auto-provisionar su
    // token de Location usando el token de Company ya guardado (best-effort).
    if (eventType === "INSTALL" && locationId) {
      const companyId =
        (body?.companyId as string | undefined) ??
        (body?.company_id as string | undefined) ??
        null;
      if (companyId) {
        provisionLocationFromStoredCompany(companyId, locationId).catch((e) =>
          request.log.error(
            `[GHL-Shadow] No se pudo provisionar token para location=${locationId}: ${e instanceof Error ? e.message : e}`,
          ),
        );
      }
    }
  } catch (err) {
    request.log.error(
      `[GHL-Shadow] Error guardando evento: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Tests para el endpoint POST /webhooks/voz
 * Ejecutar con: node --import tsx/esm --test src/tests/voz-webhook.test.ts
 */

import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

const VOZ_SECRET = "test-secret-for-voz";

let app: FastifyInstance;

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    event: "call.completed",
    call_id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    accountid: 33,
    estado: "interesado",
    phone: "+5215512345678",
    client_email: "lead@example.com",
    client_whatsapp: "+5215512345678",
    broker_name: "Juan Pérez",
    userid: "user_ghl_123",
    transcript: "Hola, me interesa el producto...",
    short_summary: "Lead interesado en producto premium",
    duration_seconds: 120,
    ...overrides,
  };
}

async function sendVoz(
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/webhooks/voz",
    payload,
    headers: {
      "content-type": "application/json",
      "x-voz-secret": VOZ_SECRET,
      ...headers,
    },
  });
}

describe("POST /webhooks/voz", () => {
  beforeEach(async () => {
    process.env.VOZ_WEBHOOK_SECRET = VOZ_SECRET;
    app = await buildApp();
  });

  test("auth inválida → 401", async () => {
    const res = await sendVoz(makePayload(), { "x-voz-secret": "wrong-secret" });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);
  });

  test("sin header X-Voz-Secret → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/voz",
      payload: makePayload(),
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.statusCode, 401);
  });

  test("estado interesado → 200", async () => {
    const res = await sendVoz(makePayload({ estado: "interesado" }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
  });

  test("estado no_interesado → 200", async () => {
    const res = await sendVoz(makePayload({ estado: "no_interesado" }));
    assert.equal(res.statusCode, 200);
  });

  test("estado no_elegible → 200", async () => {
    const res = await sendVoz(makePayload({ estado: "no_elegible" }));
    assert.equal(res.statusCode, 200);
  });

  test("estado reagendado → 200", async () => {
    const res = await sendVoz(makePayload({ estado: "reagendado" }));
    assert.equal(res.statusCode, 200);
  });

  test("estado no_contesto → 200", async () => {
    const res = await sendVoz(makePayload({ estado: "no_contesto" }));
    assert.equal(res.statusCode, 200);
  });

  test("estado buzon_voz → 200", async () => {
    const res = await sendVoz(makePayload({ estado: "buzon_voz" }));
    assert.equal(res.statusCode, 200);
  });

  test("estado colgo_temprano → 200", async () => {
    const res = await sendVoz(makePayload({ estado: "colgo_temprano" }));
    assert.equal(res.statusCode, 200);
  });

  test("estado error → 200 (goes to orphan)", async () => {
    const res = await sendVoz(makePayload({ estado: "error" }));
    assert.equal(res.statusCode, 200);
  });

  test("estado desconocido → 200 (goes to orphan)", async () => {
    const res = await sendVoz(makePayload({ estado: "desconocido" }));
    assert.equal(res.statusCode, 200);
  });

  test("idempotencia: mismo call_id no duplica", async () => {
    const callId = `call_idempotent_${Date.now()}`;
    const payload = makePayload({ call_id: callId });

    const res1 = await sendVoz(payload);
    assert.equal(res1.statusCode, 200);

    const res2 = await sendVoz(payload);
    assert.equal(res2.statusCode, 200);
  });

  test("cuenta inexistente → 200 (orphan)", async () => {
    const res = await sendVoz(makePayload({ accountid: 999999 }));
    assert.equal(res.statusCode, 200);
  });

  test("accountid no numérico → 200 (orphan)", async () => {
    const res = await sendVoz(makePayload({ accountid: "abc" }));
    assert.equal(res.statusCode, 200);
  });
});

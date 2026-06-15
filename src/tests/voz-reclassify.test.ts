/**
 * Tests para la capa defensiva de reclasificación IA en voz_callai
 * Ejecutar con: node --import tsx/esm --test src/tests/voz-reclassify.test.ts
 *
 * AUT-958: capa defensiva que reclasifica estados sospechosos de voz_callai
 * usando el clasificador IA existente.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mapClassifierToVozEstado,
  maybeReclassifyVozEstado,
  VOZ_RECLASSIFY_CHAR_THRESHOLD,
  type ClassifyCallFn,
} from "../services/webhooks/voz.service.js";

function fakeCuenta(): Parameters<typeof maybeReclassifyVozEstado>[2] {
  return {
    id_cuenta: 30,
    nombre_cuenta: "test",
    openai_api_key: null,
    embudo_personalizado: null,
    prompt_ventas: null,
    prompt_llamadas: null,
  } as Parameters<typeof maybeReclassifyVozEstado>[2];
}

function fakeClassifier(
  response: { buzon: boolean | null; estado: string | null; iadesc: string | null; tags_internos: string[] },
): ClassifyCallFn {
  return (async () => response) as unknown as ClassifyCallFn;
}

function failingClassifier(error: Error): ClassifyCallFn {
  return (async () => { throw error; }) as unknown as ClassifyCallFn;
}

function hangingClassifier(): ClassifyCallFn {
  return (() => new Promise(() => {})) as unknown as ClassifyCallFn;
}

// ─── mapClassifierToVozEstado ────────────────────────────────────────────────

describe("mapClassifierToVozEstado", () => {
  test("buzon=true → buzon_voz (ignores estado)", () => {
    assert.equal(mapClassifierToVozEstado(true, "seguimiento"), "buzon_voz");
    assert.equal(mapClassifierToVozEstado(true, "no_interesado"), "buzon_voz");
    assert.equal(mapClassifierToVozEstado(true, null), "buzon_voz");
  });

  test("buzon=null + seguimiento/null → no_contesto", () => {
    assert.equal(mapClassifierToVozEstado(null, "seguimiento"), "no_contesto");
    assert.equal(mapClassifierToVozEstado(null, null), "no_contesto");
  });

  test("buzon=false + interesado → interesado", () => {
    assert.equal(mapClassifierToVozEstado(false, "interesado"), "interesado");
  });

  test("buzon=false + no_interesado → no_interesado", () => {
    assert.equal(mapClassifierToVozEstado(false, "no_interesado"), "no_interesado");
  });

  test("buzon=false + programado → reagendado", () => {
    assert.equal(mapClassifierToVozEstado(false, "programado"), "reagendado");
  });

  test("buzon=false + seguimiento → no_contesto", () => {
    assert.equal(mapClassifierToVozEstado(false, "seguimiento"), "no_contesto");
  });

  test("buzon=false + unknown → no_contesto (default)", () => {
    assert.equal(mapClassifierToVozEstado(false, "algo_raro"), "no_contesto");
  });
});

// ─── maybeReclassifyVozEstado ────────────────────────────────────────────────

describe("maybeReclassifyVozEstado", () => {
  test("passthrough: estado=interesado + transcript largo → no reclasifica, no llama IA", async () => {
    let called = false;
    const spy = (async () => { called = true; return { buzon: null, estado: null, iadesc: null, tags_internos: [] }; }) as unknown as ClassifyCallFn;

    const result = await maybeReclassifyVozEstado("interesado", "A".repeat(200), fakeCuenta(), "[test]", spy);

    assert.equal(result.reclassified, false);
    assert.equal(result.estadoFinal, "interesado");
    assert.equal(called, false);
  });

  test("passthrough: estado=buzon_voz + transcript largo → no reclasifica", async () => {
    let called = false;
    const spy = (async () => { called = true; return { buzon: null, estado: null, iadesc: null, tags_internos: [] }; }) as unknown as ClassifyCallFn;

    const result = await maybeReclassifyVozEstado("buzon_voz", "A".repeat(200), fakeCuenta(), "[test]", spy);

    assert.equal(result.reclassified, false);
    assert.equal(result.estadoFinal, "buzon_voz");
    assert.equal(called, false);
  });

  test("trigger por etiqueta sospechosa: no_interesado → reclasifica a buzon_voz", async () => {
    const classifier = fakeClassifier({ buzon: true, estado: "seguimiento", iadesc: "Buzón de voz", tags_internos: [] });

    const result = await maybeReclassifyVozEstado(
      "no_interesado",
      "Deje su mensaje después del tono. Bip.",
      fakeCuenta(),
      "[test]",
      classifier,
    );

    assert.equal(result.reclassified, true);
    assert.equal(result.estadoFinal, "buzon_voz");
    assert.equal(result.estadoOriginal, "no_interesado");
    assert.ok(result.motivo?.includes("estado_sospechoso"));
  });

  test("trigger por etiqueta sospechosa: no_interesado → reclasifica a interesado", async () => {
    const classifier = fakeClassifier({ buzon: false, estado: "interesado", iadesc: "Mostró interés", tags_internos: [] });

    const result = await maybeReclassifyVozEstado(
      "no_interesado",
      "Sí, me interesa mucho, ¿pueden enviarme más info por WhatsApp?",
      fakeCuenta(),
      "[test]",
      classifier,
    );

    assert.equal(result.reclassified, true);
    assert.equal(result.estadoFinal, "interesado");
    assert.equal(result.estadoOriginal, "no_interesado");
  });

  test("trigger por transcript corto: interesado con 10 chars → reclasifica a no_contesto", async () => {
    const shortTranscript = "Hola bueno";
    assert.ok(shortTranscript.length < VOZ_RECLASSIFY_CHAR_THRESHOLD);

    const classifier = fakeClassifier({ buzon: null, estado: "seguimiento", iadesc: "Sin conversación", tags_internos: [] });

    const result = await maybeReclassifyVozEstado(
      "interesado",
      shortTranscript,
      fakeCuenta(),
      "[test]",
      classifier,
    );

    assert.equal(result.reclassified, true);
    assert.equal(result.estadoFinal, "no_contesto");
    assert.ok(result.motivo?.includes("transcript_corto"));
  });

  test("IA confirma estado original → no reclasifica pero registra motivo", async () => {
    const classifier = fakeClassifier({ buzon: false, estado: "no_interesado", iadesc: "Rechazó", tags_internos: [] });

    const result = await maybeReclassifyVozEstado(
      "no_interesado",
      "No me interesa, quíteme de su lista.",
      fakeCuenta(),
      "[test]",
      classifier,
    );

    assert.equal(result.reclassified, false);
    assert.equal(result.estadoFinal, "no_interesado");
    assert.ok(result.motivo?.includes("confirmado"));
  });

  test("fail-open: error de IA preserva estado original", async () => {
    const classifier = failingClassifier(new Error("OpenAI rate limit"));

    const result = await maybeReclassifyVozEstado(
      "no_interesado",
      "Algún transcript que debería procesarse",
      fakeCuenta(),
      "[test]",
      classifier,
    );

    assert.equal(result.reclassified, false);
    assert.equal(result.estadoFinal, "no_interesado");
    assert.ok(result.motivo?.includes("fail-open"));
  });

  test("fail-open: timeout preserva estado original", async () => {
    const classifier = hangingClassifier();

    const result = await maybeReclassifyVozEstado(
      "no_interesado",
      "Transcript que tardará en procesar",
      fakeCuenta(),
      "[test]",
      classifier,
    );

    assert.equal(result.reclassified, false);
    assert.equal(result.estadoFinal, "no_interesado");
    assert.ok(result.motivo?.includes("fail-open"));
  });

  test("transcript vacío → no dispara reclasificación", async () => {
    let called = false;
    const spy = (async () => { called = true; return { buzon: null, estado: null, iadesc: null, tags_internos: [] }; }) as unknown as ClassifyCallFn;

    const result = await maybeReclassifyVozEstado("no_interesado", "", fakeCuenta(), "[test]", spy);

    assert.equal(result.reclassified, false);
    assert.equal(result.estadoFinal, "no_interesado");
    assert.equal(called, false);
  });

  test("transcript solo whitespace → no dispara reclasificación", async () => {
    let called = false;
    const spy = (async () => { called = true; return { buzon: null, estado: null, iadesc: null, tags_internos: [] }; }) as unknown as ClassifyCallFn;

    const result = await maybeReclassifyVozEstado("no_interesado", "   \n  ", fakeCuenta(), "[test]", spy);

    assert.equal(result.reclassified, false);
    assert.equal(called, false);
  });

  test("VOZ_RECLASSIFY_CHAR_THRESHOLD defaults to 120", () => {
    assert.equal(VOZ_RECLASSIFY_CHAR_THRESHOLD, 120);
  });
});

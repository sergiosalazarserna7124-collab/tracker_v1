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
  VOZ_BAND_LOW_THRESHOLD,
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

  test("trigger por etiqueta sospechosa: no_interesado → reclasifica a buzon_voz (banda IA)", async () => {
    const classifier = fakeClassifier({ buzon: true, estado: "seguimiento", iadesc: "Buzón de voz", tags_internos: [] });

    const longBuzon = "Hola, en este momento no puedo atender su llamada, por favor deje su mensaje después del tono y con gusto le devolveré la llamada lo antes posible. Bip.";
    assert.ok(longBuzon.trim().length >= VOZ_BAND_LOW_THRESHOLD);

    const result = await maybeReclassifyVozEstado(
      "no_interesado",
      longBuzon,
      fakeCuenta(),
      "[test]",
      classifier,
    );

    assert.equal(result.reclassified, true);
    assert.equal(result.estadoFinal, "buzon_voz");
    assert.equal(result.estadoOriginal, "no_interesado");
    assert.ok(result.motivo?.includes("estado_sospechoso"));
  });

  test("trigger por etiqueta sospechosa: no_interesado → reclasifica a interesado (banda IA)", async () => {
    const classifier = fakeClassifier({ buzon: false, estado: "interesado", iadesc: "Mostró interés", tags_internos: [] });

    const longTranscript = "Sí, me interesa mucho el proyecto, ¿pueden enviarme más info por WhatsApp? Me gustaría ver opciones de financiamiento y también saber los plazos de entrega aproximados.";
    assert.ok(longTranscript.trim().length >= VOZ_BAND_LOW_THRESHOLD);

    const result = await maybeReclassifyVozEstado(
      "no_interesado",
      longTranscript,
      fakeCuenta(),
      "[test]",
      classifier,
    );

    assert.equal(result.reclassified, true);
    assert.equal(result.estadoFinal, "interesado");
    assert.equal(result.estadoOriginal, "no_interesado");
  });

  test("trigger por transcript corto: interesado con 10 chars → banda baja → buzon_voz (AUT-961)", async () => {
    const shortTranscript = "Hola bueno";
    assert.ok(shortTranscript.length < VOZ_BAND_LOW_THRESHOLD);

    let called = false;
    const spy = (async () => { called = true; return { buzon: null, estado: "seguimiento", iadesc: "Sin conversación", tags_internos: [] }; }) as unknown as ClassifyCallFn;

    const result = await maybeReclassifyVozEstado(
      "interesado",
      shortTranscript,
      fakeCuenta(),
      "[test]",
      spy,
    );

    assert.equal(result.reclassified, true);
    assert.equal(result.estadoFinal, "buzon_voz");
    assert.ok(result.motivo?.includes("banda_baja_determinista"));
    assert.equal(called, false, "IA must NOT be called for banda baja");
  });

  test("IA confirma estado original → no reclasifica pero registra motivo (banda IA)", async () => {
    const classifier = fakeClassifier({ buzon: false, estado: "no_interesado", iadesc: "Rechazó", tags_internos: [] });

    const longTranscript = "No me interesa para nada, ya les dije que no quiero saber de inmobiliarias, quítenme de su lista de contactos por favor, no me vuelvan a llamar nunca más. Gracias.";
    assert.ok(longTranscript.trim().length >= VOZ_BAND_LOW_THRESHOLD);

    const result = await maybeReclassifyVozEstado(
      "no_interesado",
      longTranscript,
      fakeCuenta(),
      "[test]",
      classifier,
    );

    assert.equal(result.reclassified, false);
    assert.equal(result.estadoFinal, "no_interesado");
    assert.ok(result.motivo?.includes("confirmado"));
  });

  test("fail-open: error de IA preserva estado original (banda IA)", async () => {
    const classifier = failingClassifier(new Error("OpenAI rate limit"));

    const longTranscript = "Algún transcript suficientemente largo que debería procesarse por el clasificador de IA pero la IA falla y se preserva el estado original del webhook.";
    assert.ok(longTranscript.trim().length >= VOZ_BAND_LOW_THRESHOLD);

    const result = await maybeReclassifyVozEstado(
      "no_interesado",
      longTranscript,
      fakeCuenta(),
      "[test]",
      classifier,
    );

    assert.equal(result.reclassified, false);
    assert.equal(result.estadoFinal, "no_interesado");
    assert.ok(result.motivo?.includes("fail-open"));
  });

  test("fail-open: timeout preserva estado original (banda IA)", async () => {
    const classifier = hangingClassifier();

    const longTranscript = "Transcript suficientemente largo que tardará en procesar por el clasificador de inteligencia artificial pero nunca responde y se dispara el timeout de ocho segundos completo.";
    assert.ok(longTranscript.trim().length >= VOZ_BAND_LOW_THRESHOLD);

    const result = await maybeReclassifyVozEstado(
      "no_interesado",
      longTranscript,
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

  test("VOZ_BAND_LOW_THRESHOLD defaults to 150", () => {
    assert.equal(VOZ_BAND_LOW_THRESHOLD, 150);
  });
});

// ─── Bandas por longitud de transcript (AUT-961) ────────────────────────────

describe("maybeReclassifyVozEstado — bandas por longitud", () => {
  test("banda baja: transcript < 150 chars + no_interesado → buzon_voz SIN llamar IA", async () => {
    let called = false;
    const spy = (async () => { called = true; return { buzon: null, estado: null, iadesc: null, tags_internos: [] }; }) as unknown as ClassifyCallFn;

    const shortText = "Deje su mensaje después del tono.";
    assert.ok(shortText.length < VOZ_BAND_LOW_THRESHOLD, `precondition: len=${shortText.length} < ${VOZ_BAND_LOW_THRESHOLD}`);

    const result = await maybeReclassifyVozEstado("no_interesado", shortText, fakeCuenta(), "[test]", spy);

    assert.equal(result.reclassified, true);
    assert.equal(result.estadoFinal, "buzon_voz");
    assert.equal(result.estadoOriginal, "no_interesado");
    assert.ok(result.motivo?.includes("banda_baja_determinista"));
    assert.equal(result.iaDesc, null);
    assert.equal(called, false, "IA classifier must NOT be called for banda baja");
  });

  test("banda baja: transcript corto + estado no sospechoso (interesado) → buzon_voz SIN IA", async () => {
    let called = false;
    const spy = (async () => { called = true; return { buzon: null, estado: null, iadesc: null, tags_internos: [] }; }) as unknown as ClassifyCallFn;

    const shortText = "A".repeat(50);
    assert.ok(shortText.length < VOZ_RECLASSIFY_CHAR_THRESHOLD);

    const result = await maybeReclassifyVozEstado("interesado", shortText, fakeCuenta(), "[test]", spy);

    assert.equal(result.reclassified, true);
    assert.equal(result.estadoFinal, "buzon_voz");
    assert.equal(called, false, "IA classifier must NOT be called for banda baja");
  });

  test("banda baja: buzon_voz con transcript corto → buzon_voz (reclassified=false)", async () => {
    let called = false;
    const spy = (async () => { called = true; return { buzon: null, estado: null, iadesc: null, tags_internos: [] }; }) as unknown as ClassifyCallFn;

    const shortText = "Buzón de voz.";
    assert.ok(shortText.length < VOZ_BAND_LOW_THRESHOLD);

    const result = await maybeReclassifyVozEstado("buzon_voz", shortText, fakeCuenta(), "[test]", spy);

    assert.equal(result.estadoFinal, "buzon_voz");
    assert.equal(result.reclassified, false, "buzon_voz → buzon_voz is not a change");
    assert.equal(called, false);
  });

  test("borde: transcript exactamente 149 chars (< 150) → banda baja, sin IA", async () => {
    let called = false;
    const spy = (async () => { called = true; return { buzon: null, estado: null, iadesc: null, tags_internos: [] }; }) as unknown as ClassifyCallFn;

    const text = "A".repeat(149);
    assert.equal(text.length, 149);

    const result = await maybeReclassifyVozEstado("no_interesado", text, fakeCuenta(), "[test]", spy);

    assert.equal(result.estadoFinal, "buzon_voz");
    assert.ok(result.motivo?.includes("banda_baja_determinista"));
    assert.equal(called, false);
  });

  test("borde: transcript exactamente 150 chars (≥ 150) → banda IA, SÍ llama clasificador", async () => {
    let called = false;
    const classifier = (async () => {
      called = true;
      return { buzon: false, estado: "no_interesado", iadesc: "Rechazó", tags_internos: [] };
    }) as unknown as ClassifyCallFn;

    const text = "A".repeat(150);
    assert.equal(text.length, 150);

    const result = await maybeReclassifyVozEstado("no_interesado", text, fakeCuenta(), "[test]", classifier);

    assert.equal(called, true, "IA classifier MUST be called for transcript ≥ 150");
    assert.equal(result.estadoFinal, "no_interesado");
    assert.ok(result.motivo?.includes("confirmado"));
  });

  test("borde: transcript 151 chars → banda IA", async () => {
    let called = false;
    const classifier = (async () => {
      called = true;
      return { buzon: true, estado: "seguimiento", iadesc: "Buzón", tags_internos: [] };
    }) as unknown as ClassifyCallFn;

    const text = "A".repeat(151);

    const result = await maybeReclassifyVozEstado("no_interesado", text, fakeCuenta(), "[test]", classifier);

    assert.equal(called, true, "IA classifier MUST be called for transcript > 150");
    assert.equal(result.estadoFinal, "buzon_voz");
    assert.equal(result.reclassified, true);
  });

  test("banda IA: transcript largo + no_interesado → IA reclasifica a interesado", async () => {
    const classifier = fakeClassifier({ buzon: false, estado: "interesado", iadesc: "Interés real", tags_internos: [] });

    const longText = "A".repeat(200);
    assert.ok(longText.length >= VOZ_BAND_LOW_THRESHOLD);

    const result = await maybeReclassifyVozEstado("no_interesado", longText, fakeCuenta(), "[test]", classifier);

    assert.equal(result.reclassified, true);
    assert.equal(result.estadoFinal, "interesado");
    assert.ok(result.motivo?.includes("banda_ia"));
  });

  test("banda IA: fail-open preserva estado en banda media/alta", async () => {
    const classifier = failingClassifier(new Error("OpenAI down"));

    const longText = "A".repeat(200);

    const result = await maybeReclassifyVozEstado("no_interesado", longText, fakeCuenta(), "[test]", classifier);

    assert.equal(result.reclassified, false);
    assert.equal(result.estadoFinal, "no_interesado");
    assert.ok(result.motivo?.includes("fail-open"));
  });
});

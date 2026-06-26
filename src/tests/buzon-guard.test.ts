/**
 * Tests del guard defensivo contra falsos "buzón" en llamadas contestadas.
 * Ejecutar con: node --import tsx/esm --test src/tests/buzon-guard.test.ts
 *
 * AUT-1083: el clasificador IA marca buzon=true en llamadas cortas donde el
 * lead SÍ contestó y conversó (saludó + rechazó/preguntó). El guard las
 * reclasifica a contestada de forma determinista y conservadora.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeAnsweredConversation,
  applyAnsweredCallGuard,
  type CallClassification,
} from "../services/ai/call-classification.service.js";

// Transcripción REAL del caso reportado (log_llamadas 129191, Shark re).
const TRANSCRIPT_129191 =
  "¿Bueno? ¿Hola? Diga. Hola, buenas tardes. ¿Qué tal? Te saluda Max Sánchez, de Shark Realtor. " +
  "No sé si te acuerdas de mí, de las propiedades acá en el Caribe mexicano. Una casa que te gustó " +
  "en Playa del Carmen, ¿sí recuerdas? No, disculpe. Me dejaste tu información por una casa en Playa " +
  "del Carmen, pero no me dejaste tu nombre, entraste como JXSXSY alguien de mi equipo te intentó " +
  "contactar, pero no había tenido éxito. ¿No te acuerdas de una inversión, o más bien, de una " +
  "propiedad que llamó tu atención, Empleida del Carmen? No, disculpe. Ok, descuida, no pasa nada. " +
  "Gracias. Sí, hasta luego.";

function buzonClassification(
  over: Partial<CallClassification> = {},
): CallClassification {
  return { buzon: true, estado: null, iadesc: "desc", tags_internos: [], ...over };
}

describe("looksLikeAnsweredConversation", () => {
  test("caso real 129191: lead contestó y rechazó → true", () => {
    assert.equal(looksLikeAnsweredConversation(TRANSCRIPT_129191), true);
  });

  test("buzón de voz clásico (deje su mensaje) → false", () => {
    const t =
      "Hola, has llamado al buzón de voz de Juan. En este momento no estoy disponible, " +
      "por favor deja tu mensaje después del tono y te devolveré la llamada lo antes posible.";
    assert.equal(looksLikeAnsweredConversation(t), false);
  });

  test("call-screening iPhone (revisaré si está disponible) → false", () => {
    // Mismo patrón que log_llamadas 104960 — buzón correcto, NO debe reclasificar.
    const t =
      "Hola, si dejas tu nombre y el móvil de llamada, revisaré si esta persona está " +
      "disponible para atender tu llamada en este momento, gracias.";
    assert.equal(looksLikeAnsweredConversation(t), false);
  });

  test("voicemail en inglés (leave a message after the beep) → false", () => {
    const t =
      "Hi, you've reached the voicemail box. I can't come to the phone right now, " +
      "please leave a message after the beep and I'll get back to you.";
    assert.equal(looksLikeAnsweredConversation(t), false);
  });

  test("monólogo del asesor sin contenido del lead → false", () => {
    // Patrón de log_llamadas 112271 — sin frases de engagement del lead.
    const t =
      "Aquí estoy hablando. Todo lo que hablo queda grabado en el CRM. Al mismo tiempo se " +
      "puede utilizar para mandar información, analizar los datos y ver qué tipo de lead llega.";
    assert.equal(looksLikeAnsweredConversation(t), false);
  });

  test("transcripción demasiado corta → false", () => {
    assert.equal(looksLikeAnsweredConversation("¿Bueno? ¿Hola? No, disculpe."), false);
  });

  test("vacío / null → false", () => {
    assert.equal(looksLikeAnsweredConversation(""), false);
    assert.equal(looksLikeAnsweredConversation(null), false);
    assert.equal(looksLikeAnsweredConversation(undefined), false);
  });
});

describe("applyAnsweredCallGuard", () => {
  test("buzon=true + conversación real → flip a buzon=false, estado seguimiento", () => {
    const out = applyAnsweredCallGuard(buzonClassification(), TRANSCRIPT_129191);
    assert.equal(out.buzon, false);
    assert.equal(out.estado, "seguimiento"); // null → fallback, no inventa etapa
    assert.equal(out.iadesc, "desc"); // se preserva
  });

  test("buzon=true + estado custom no-null se preserva al flipear", () => {
    const out = applyAnsweredCallGuard(
      buzonClassification({ estado: "lead_calificado" }),
      TRANSCRIPT_129191,
    );
    assert.equal(out.buzon, false);
    assert.equal(out.estado, "lead_calificado");
  });

  test("buzon=true + buzón real → NO toca (sigue buzon=true)", () => {
    const t = "Por favor deja tu mensaje después del tono. Gracias por llamar.";
    const out = applyAnsweredCallGuard(buzonClassification(), t);
    assert.equal(out.buzon, true);
  });

  test("buzon=null (llamada fallida/cortada) → NUNCA se toca", () => {
    const out = applyAnsweredCallGuard(
      buzonClassification({ buzon: null }),
      TRANSCRIPT_129191,
    );
    assert.equal(out.buzon, null);
  });

  test("buzon=false (ya contestada) → se devuelve igual", () => {
    const c = buzonClassification({ buzon: false, estado: "interesado" });
    const out = applyAnsweredCallGuard(c, TRANSCRIPT_129191);
    assert.equal(out.buzon, false);
    assert.equal(out.estado, "interesado");
  });
});

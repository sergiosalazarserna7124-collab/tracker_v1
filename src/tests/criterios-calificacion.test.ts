/**
 * Tests unitarios para criterios de calificación configurables.
 *
 * AUT-413: criterios de calificación configurables por cuenta.
 * AUT-1327: criterios por canal (chats, llamadas, videollamadas).
 * Ejecutar con: node --import tsx/esm --test src/tests/criterios-calificacion.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseCriteriosCalificacion,
  esCalificado,
  resolverCriterios,
  CRITERIOS_DEFAULT,
  DEFAULTS_POR_CANAL,
} from "../services/data/criterios-calificacion.utils.js";

// ─── parseCriteriosCalificacion ───────────────────────────────────────────────

describe("parseCriteriosCalificacion — validación", () => {
  test("happy path: objeto válido mínimo", () => {
    const result = parseCriteriosCalificacion({
      categorias_calificadas: ["presupuesto", "urgencia"],
    });
    assert.deepEqual(result.categorias_calificadas, ["presupuesto", "urgencia"]);
    assert.equal(result.umbral_minimo, 1); // default
  });

  test("happy path: con umbral_minimo explícito", () => {
    const result = parseCriteriosCalificacion({
      categorias_calificadas: ["cliente_ganado"],
      umbral_minimo: 2,
    });
    assert.equal(result.umbral_minimo, 2);
  });

  test("normaliza strings con espacios", () => {
    const result = parseCriteriosCalificacion({
      categorias_calificadas: ["  presupuesto  ", " urgencia"],
    });
    assert.deepEqual(result.categorias_calificadas, ["presupuesto", "urgencia"]);
  });

  test("lanza error si categorias_calificadas no es array", () => {
    assert.throws(
      () => parseCriteriosCalificacion({ categorias_calificadas: "presupuesto" }),
      /categorias_calificadas debe ser un array/,
    );
  });

  test("lanza error si un elemento del array no es string", () => {
    assert.throws(
      () => parseCriteriosCalificacion({ categorias_calificadas: [1, 2] }),
      /string no vacío/,
    );
  });

  test("lanza error si umbral_minimo es 0", () => {
    assert.throws(
      () =>
        parseCriteriosCalificacion({
          categorias_calificadas: ["presupuesto"],
          umbral_minimo: 0,
        }),
      /umbral_minimo debe ser un entero positivo/,
    );
  });

  test("lanza error si es null", () => {
    assert.throws(() => parseCriteriosCalificacion(null), /no puede ser null/);
  });

  test("lanza error si es un array", () => {
    assert.throws(() => parseCriteriosCalificacion([]), /debe ser un objeto/);
  });
});

// ─── parseCriteriosCalificacion — canales ─────────────────────────────────────

describe("parseCriteriosCalificacion — canales", () => {
  test("acepta estructura con canales válidos", () => {
    const result = parseCriteriosCalificacion({
      categorias_calificadas: ["presupuesto"],
      canales: {
        chats: { categorias_calificadas: ["urgencia", "cliente_ganado"] },
        llamadas: { categorias_calificadas: ["presupuesto"], umbral_minimo: 2 },
      },
    });
    assert.deepEqual(result.canales?.chats?.categorias_calificadas, ["urgencia", "cliente_ganado"]);
    assert.equal(result.canales?.chats?.umbral_minimo, 1);
    assert.deepEqual(result.canales?.llamadas?.categorias_calificadas, ["presupuesto"]);
    assert.equal(result.canales?.llamadas?.umbral_minimo, 2);
    assert.equal(result.canales?.videollamadas, undefined);
  });

  test("estructura legacy sin canales sigue funcionando", () => {
    const result = parseCriteriosCalificacion({
      categorias_calificadas: ["presupuesto"],
    });
    assert.equal(result.canales, undefined);
  });

  test("canales vacío no se incluye en resultado", () => {
    const result = parseCriteriosCalificacion({
      categorias_calificadas: ["presupuesto"],
      canales: {},
    });
    assert.equal(result.canales, undefined);
  });

  test("lanza error si canales no es objeto", () => {
    assert.throws(
      () =>
        parseCriteriosCalificacion({
          categorias_calificadas: ["presupuesto"],
          canales: "chats",
        }),
      /canales debe ser un objeto/,
    );
  });

  test("lanza error si canales tiene clave desconocida", () => {
    assert.throws(
      () =>
        parseCriteriosCalificacion({
          categorias_calificadas: ["presupuesto"],
          canales: { emails: { categorias_calificadas: ["test"] } },
        }),
      /claves no válidas: emails/,
    );
  });

  test("lanza error si canal tiene categorias_calificadas inválidas", () => {
    assert.throws(
      () =>
        parseCriteriosCalificacion({
          categorias_calificadas: ["presupuesto"],
          canales: { chats: { categorias_calificadas: "test" } },
        }),
      /canales\.chats\.categorias_calificadas debe ser un array/,
    );
  });

  test("normaliza strings en canales", () => {
    const result = parseCriteriosCalificacion({
      categorias_calificadas: ["presupuesto"],
      canales: {
        videollamadas: { categorias_calificadas: ["  urgencia  ", " test "] },
      },
    });
    assert.deepEqual(result.canales?.videollamadas?.categorias_calificadas, ["urgencia", "test"]);
  });
});

// ─── resolverCriterios ────────────────────────────────────────────────────────

describe("resolverCriterios", () => {
  const criteriosConCanales = parseCriteriosCalificacion({
    categorias_calificadas: ["presupuesto", "urgencia"],
    canales: {
      chats: { categorias_calificadas: ["cliente_ganado"] },
      llamadas: { categorias_calificadas: ["no_interesado"], umbral_minimo: 3 },
    },
  });

  test("sin canal → devuelve global", () => {
    const ef = resolverCriterios(criteriosConCanales);
    assert.deepEqual(ef.categorias_calificadas, ["presupuesto", "urgencia"]);
    assert.equal(ef.umbral_minimo, 1);
  });

  test("canal con criterios propios → devuelve los del canal", () => {
    const ef = resolverCriterios(criteriosConCanales, "chats");
    assert.deepEqual(ef.categorias_calificadas, ["cliente_ganado"]);
  });

  test("canal sin criterios propios → fallback a global", () => {
    const ef = resolverCriterios(criteriosConCanales, "videollamadas");
    assert.deepEqual(ef.categorias_calificadas, ["presupuesto", "urgencia"]);
  });

  test("criterios sin canales + canal especificado → global", () => {
    const sinCanales = parseCriteriosCalificacion({
      categorias_calificadas: ["presupuesto"],
    });
    const ef = resolverCriterios(sinCanales, "chats");
    assert.deepEqual(ef.categorias_calificadas, ["presupuesto"]);
  });
});

// ─── esCalificado ─────────────────────────────────────────────────────────────

describe("esCalificado — lógica de calificación", () => {
  const criterios = {
    categorias_calificadas: ["presupuesto", "urgencia", "cliente_ganado"],
    umbral_minimo: 1,
  };

  test("null criterios → usa defaults (AUT-1659)", () => {
    assert.equal(esCalificado("calificada", null), true);
    assert.equal(esCalificado("cerrada", null), true);
    assert.equal(esCalificado("interesado", null), true);
    assert.equal(esCalificado("no_interesado", null), false);
    assert.equal(esCalificado("no_calificada", null), false);
    assert.equal(esCalificado(null, null), false);
  });

  test("categoria calificada → es_calificado=true", () => {
    assert.equal(esCalificado("presupuesto", criterios), true);
    assert.equal(esCalificado("urgencia", criterios), true);
    assert.equal(esCalificado("cliente_ganado", criterios), true);
  });

  test("categoria no calificada → es_calificado=false", () => {
    assert.equal(esCalificado("no_interesado", criterios), false);
    assert.equal(esCalificado("sin_mensajes", criterios), false);
    assert.equal(esCalificado("error_analisis", criterios), false);
  });

  test("ia_categoria null con criterios definidos → false", () => {
    assert.equal(esCalificado(null, criterios), false);
  });
});

// ─── esCalificado — con canal ─────────────────────────────────────────────────

describe("esCalificado — con canal", () => {
  const criterios = parseCriteriosCalificacion({
    categorias_calificadas: ["presupuesto", "urgencia"],
    canales: {
      chats: { categorias_calificadas: ["cliente_ganado", "presupuesto"] },
    },
  });

  test("canal con criterios propios usa esos criterios", () => {
    assert.equal(esCalificado("cliente_ganado", criterios, "chats"), true);
    assert.equal(esCalificado("urgencia", criterios, "chats"), false);
  });

  test("canal sin criterios propios usa global", () => {
    assert.equal(esCalificado("urgencia", criterios, "llamadas"), true);
    assert.equal(esCalificado("cliente_ganado", criterios, "llamadas"), false);
  });

  test("sin canal usa global (backward compat)", () => {
    assert.equal(esCalificado("urgencia", criterios), true);
    assert.equal(esCalificado("cliente_ganado", criterios), false);
  });

  test("null criterios + canal → usa defaults del canal (AUT-1659)", () => {
    assert.equal(esCalificado("calificada", null, "chats"), true);
    assert.equal(esCalificado("interesado", null, "chats"), true);
    assert.equal(esCalificado("no_calificada", null, "chats"), false);
    assert.equal(esCalificado("calificada", null, "llamadas"), true);
    assert.equal(esCalificado("agendado", null, "llamadas"), true);
    assert.equal(esCalificado("no_contestada", null, "llamadas"), false);
    assert.equal(esCalificado("calificada", null, "videollamadas"), true);
    assert.equal(esCalificado("no_show", null, "videollamadas"), false);
  });
});

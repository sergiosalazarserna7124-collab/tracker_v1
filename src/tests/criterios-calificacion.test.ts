/**
 * Tests unitarios para criterios de calificación configurables.
 *
 * AUT-413: criterios de calificación configurables por cuenta.
 * Ejecutar con: node --import tsx/esm --test src/tests/criterios-calificacion.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseCriteriosCalificacion,
  esCalificado,
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

// ─── esCalificado ─────────────────────────────────────────────────────────────

describe("esCalificado — lógica de calificación", () => {
  const criterios = {
    categorias_calificadas: ["presupuesto", "urgencia", "cliente_ganado"],
    umbral_minimo: 1,
  };

  test("null fallback: criterios=null → siempre true", () => {
    assert.equal(esCalificado("no_interesado", null), true);
    assert.equal(esCalificado(null, null), true);
    assert.equal(esCalificado("presupuesto", null), true);
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

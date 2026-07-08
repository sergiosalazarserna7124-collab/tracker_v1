/**
 * Tests para umbral_minimo en esCalificado.
 * AUT-1329: implementar umbral_minimo (era dead code).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseCriteriosCalificacion,
  esCalificado,
} from "../services/data/criterios-calificacion.utils.js";

describe("esCalificado — umbral_minimo", () => {
  const criteriosUmbral2 = parseCriteriosCalificacion({
    categorias_calificadas: ["presupuesto", "urgencia", "cliente_ganado"],
    umbral_minimo: 2,
  });

  test("umbral=1 con string único: calificado si coincide (backward compat)", () => {
    const criteriosUmbral1 = parseCriteriosCalificacion({
      categorias_calificadas: ["presupuesto", "urgencia"],
    });
    assert.equal(esCalificado("presupuesto", criteriosUmbral1), true);
    assert.equal(esCalificado("no_interesado", criteriosUmbral1), false);
  });

  test("umbral=2 con string único: no calificado (1 < 2)", () => {
    assert.equal(esCalificado("presupuesto", criteriosUmbral2), false);
  });

  test("umbral=2 con array de 2 categorías que coinciden: calificado", () => {
    assert.equal(esCalificado(["presupuesto", "urgencia"], criteriosUmbral2), true);
  });

  test("umbral=2 con array de 3 categorías, solo 1 coincide: no calificado", () => {
    assert.equal(esCalificado(["presupuesto", "no_interesado", "sin_mensajes"], criteriosUmbral2), false);
  });

  test("umbral=2 con array de 3 categorías, 2 coinciden: calificado", () => {
    assert.equal(esCalificado(["presupuesto", "no_interesado", "cliente_ganado"], criteriosUmbral2), true);
  });

  test("umbral=2 con array vacío: no calificado", () => {
    assert.equal(esCalificado([], criteriosUmbral2), false);
  });

  test("umbral=2 con null: no calificado", () => {
    assert.equal(esCalificado(null, criteriosUmbral2), false);
  });

  test("umbral=2 con criterios null: siempre calificado", () => {
    assert.equal(esCalificado(["presupuesto"], null), true);
  });

  test("umbral=2 con canal que tiene su propio umbral", () => {
    const criteriosConCanal = parseCriteriosCalificacion({
      categorias_calificadas: ["presupuesto", "urgencia", "cliente_ganado"],
      umbral_minimo: 1,
      canales: {
        llamadas: { categorias_calificadas: ["presupuesto", "urgencia"], umbral_minimo: 2 },
      },
    });
    assert.equal(esCalificado("presupuesto", criteriosConCanal, "llamadas"), false);
    assert.equal(esCalificado(["presupuesto", "urgencia"], criteriosConCanal, "llamadas"), true);
    assert.equal(esCalificado("presupuesto", criteriosConCanal, "chats"), true);
  });
});

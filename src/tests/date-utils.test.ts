/**
 * Tests unitarios para parseFechaReunionToUTC (date.utils)
 * Ejecutar con: node --import tsx/esm --test src/tests/date-utils.test.ts
 *
 * AUT-648: fallos de parseo de fecha (formato largo ES sin hora) + tz malformada
 *          ("america/cuidaddemexico" typo, "america/ciudaddemexico" no-IANA).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseFechaReunionToUTC } from "../utils/date.utils.js";

describe("parseFechaReunionToUTC — casos AUT-648", () => {
  test("ES formato largo SIN hora se parsea (asume 00:00 local)", () => {
    // "4 de junio de 2026" 00:00 en Bogota (UTC-5) → 05:00Z
    const r = parseFechaReunionToUTC("4 de junio de 2026", "america/bogota");
    assert.ok(r, "no debe ser null");
    assert.equal(r!.toISOString(), "2026-06-04T05:00:00.000Z");
  });

  test("tz typo 'america/cuidaddemexico' se resuelve a America/Mexico_City", () => {
    // 12:30 PM en CDMX (UTC-6) → 18:30Z
    const r = parseFechaReunionToUTC("June 6, 2026 12:30 PM", "america/cuidaddemexico");
    assert.ok(r, "no debe ser null");
    assert.equal(r!.toISOString(), "2026-06-06T18:30:00.000Z");
  });

  test("tz español 'america/ciudaddemexico' (no-IANA) se resuelve", () => {
    const r = parseFechaReunionToUTC("June 6, 2026 12:30 PM", "america/ciudaddemexico");
    assert.ok(r, "no debe ser null");
    assert.equal(r!.toISOString(), "2026-06-06T18:30:00.000Z");
  });
});

describe("parseFechaReunionToUTC — formatos soportados", () => {
  test("ES con hora 24h (legado)", () => {
    const r = parseFechaReunionToUTC("27 de febrero de 2026 15:00", "america/bogota");
    assert.equal(r!.toISOString(), "2026-02-27T20:00:00.000Z");
  });

  test("EN con AM/PM", () => {
    const r = parseFechaReunionToUTC("February 27, 2026 3:00 PM", "America/Bogota");
    assert.equal(r!.toISOString(), "2026-02-27T20:00:00.000Z");
  });

  test("EN solo fecha (asume 00:00 local)", () => {
    const r = parseFechaReunionToUTC("June 6, 2026", "America/Bogota");
    assert.equal(r!.toISOString(), "2026-06-06T05:00:00.000Z");
  });

  test("EN 24h sin AM/PM", () => {
    const r = parseFechaReunionToUTC("June 6, 2026 13:00", "America/Bogota");
    assert.equal(r!.toISOString(), "2026-06-06T18:00:00.000Z");
  });

  test("tz en cualquier capitalización", () => {
    const a = parseFechaReunionToUTC("February 27, 2026 3:00 PM", "AMERICA/BOGOTA");
    const b = parseFechaReunionToUTC("February 27, 2026 3:00 PM", "america/bogota");
    assert.equal(a!.toISOString(), b!.toISOString());
  });
});

describe("parseFechaReunionToUTC — entradas inválidas devuelven null", () => {
  test("hora o tz undefined", () => {
    assert.equal(parseFechaReunionToUTC(undefined, "america/bogota"), null);
    assert.equal(parseFechaReunionToUTC("June 6, 2026", undefined), null);
  });

  test("tz inexistente devuelve null (no se inventa zona)", () => {
    assert.equal(parseFechaReunionToUTC("June 6, 2026 12:30 PM", "america/zzz_no_existe"), null);
  });

  test("fecha basura devuelve null", () => {
    assert.equal(parseFechaReunionToUTC("no es una fecha", "america/bogota"), null);
  });
});

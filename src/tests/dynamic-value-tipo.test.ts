import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRangeLabel,
  resolveBooleanLabel,
  inferTipo,
  resolveCustomFieldValue,
} from "../services/ai/dynamic-value.utils.js";
import type {
  DynamicValueConfig,
  DynamicValueRange,
} from "../services/ai/dynamic-value.utils.js";

// ─── resolveRangeLabel ────────────────────────────────────────────────────────

describe("resolveRangeLabel", () => {
  const ranges: DynamicValueRange[] = [
    { min: 0, label: "Bajo" },
    { min: 50, label: "Medio" },
    { min: 80, label: "Alto" },
  ];

  test("returns label for exact min boundary", () => {
    assert.equal(resolveRangeLabel(80, ranges), "Alto");
  });

  test("returns label for value above highest min", () => {
    assert.equal(resolveRangeLabel(100, ranges), "Alto");
  });

  test("returns label for value between ranges", () => {
    assert.equal(resolveRangeLabel(60, ranges), "Medio");
  });

  test("returns lowest label for value at 0", () => {
    assert.equal(resolveRangeLabel(0, ranges), "Bajo");
  });

  test("returns last label for value below all mins", () => {
    assert.equal(resolveRangeLabel(-5, ranges), "Bajo");
  });
});

// ─── resolveBooleanLabel ──────────────────────────────────────────────────────

describe("resolveBooleanLabel", () => {
  test("true string → labelSi", () => {
    assert.equal(resolveBooleanLabel("true", "Activo", "Inactivo"), "Activo");
  });

  test("yes string → labelSi", () => {
    assert.equal(resolveBooleanLabel("yes", "Sí", "No"), "Sí");
  });

  test("sí with accent → labelSi", () => {
    assert.equal(resolveBooleanLabel("sí", "Caliente", "Frío"), "Caliente");
  });

  test("si without accent → labelSi", () => {
    assert.equal(resolveBooleanLabel("si", "Caliente", "Frío"), "Caliente");
  });

  test("1 string → labelSi", () => {
    assert.equal(resolveBooleanLabel("1", "On", "Off"), "On");
  });

  test("false string → labelNo", () => {
    assert.equal(resolveBooleanLabel("false", "Activo", "Inactivo"), "Inactivo");
  });

  test("no string → labelNo", () => {
    assert.equal(resolveBooleanLabel("no", "Activo", "Inactivo"), "Inactivo");
  });

  test("0 string → labelNo", () => {
    assert.equal(resolveBooleanLabel("0", "On", "Off"), "Off");
  });

  test("empty string → labelNo", () => {
    assert.equal(resolveBooleanLabel("", "On", "Off"), "Off");
  });

  test("defaults to Sí/No when labels omitted", () => {
    assert.equal(resolveBooleanLabel("true"), "Sí");
    assert.equal(resolveBooleanLabel("false"), "No");
  });

  test("boolean true value → labelSi", () => {
    assert.equal(resolveBooleanLabel(true, "A", "B"), "A");
  });

  test("case insensitive", () => {
    assert.equal(resolveBooleanLabel("TRUE", "Y", "N"), "Y");
    assert.equal(resolveBooleanLabel("Yes", "Y", "N"), "Y");
  });
});

// ─── inferTipo ────────────────────────────────────────────────────────────────

describe("inferTipo — legacy fallback", () => {
  test("config with ranges → numero", () => {
    const config: DynamicValueConfig = {
      fuente: "custom_field",
      ranges: [{ min: 0, label: "Bajo" }],
    };
    assert.equal(inferTipo(config), "numero");
  });

  test("config without ranges → texto", () => {
    const config: DynamicValueConfig = { fuente: "custom_field" };
    assert.equal(inferTipo(config), "texto");
  });

  test("config with empty ranges → texto", () => {
    const config: DynamicValueConfig = { fuente: "custom_field", ranges: [] };
    assert.equal(inferTipo(config), "texto");
  });
});

// ─── resolveCustomFieldValue ────────────────────────────────────────────────

describe("resolveCustomFieldValue", () => {
  test("tipo=numero with ranges resolves label", () => {
    const config: DynamicValueConfig = {
      fuente: "custom_field",
      tipo: "numero",
      ranges: [{ min: 0, label: "Bajo" }, { min: 50, label: "Alto" }],
    };
    assert.equal(resolveCustomFieldValue(config, "75", 75), "Alto");
  });

  test("tipo=numero without ranges returns number string", () => {
    const config: DynamicValueConfig = {
      fuente: "custom_field",
      tipo: "numero",
    };
    assert.equal(resolveCustomFieldValue(config, "42.5", 42.5), "42.5");
  });

  test("tipo=numero with non-numeric value returns raw", () => {
    const config: DynamicValueConfig = {
      fuente: "custom_field",
      tipo: "numero",
    };
    assert.equal(resolveCustomFieldValue(config, "abc", "abc"), "abc");
  });

  test("tipo=si_no with custom labels", () => {
    const config: DynamicValueConfig = {
      fuente: "custom_field",
      tipo: "si_no",
      labelSi: "Caliente",
      labelNo: "Frío",
    };
    assert.equal(resolveCustomFieldValue(config, "true", true), "Caliente");
    assert.equal(resolveCustomFieldValue(config, "false", false), "Frío");
  });

  test("tipo=si_no defaults labels", () => {
    const config: DynamicValueConfig = {
      fuente: "custom_field",
      tipo: "si_no",
    };
    assert.equal(resolveCustomFieldValue(config, "yes", "yes"), "Sí");
    assert.equal(resolveCustomFieldValue(config, "no", "no"), "No");
  });

  test("tipo=texto returns raw value", () => {
    const config: DynamicValueConfig = {
      fuente: "custom_field",
      tipo: "texto",
    };
    assert.equal(resolveCustomFieldValue(config, "hello world", "hello world"), "hello world");
  });

  test("tipo=fecha returns raw value", () => {
    const config: DynamicValueConfig = {
      fuente: "custom_field",
      tipo: "fecha",
    };
    assert.equal(resolveCustomFieldValue(config, "2026-07-07", "2026-07-07"), "2026-07-07");
  });

  test("legacy config without tipo + ranges → inferred as numero", () => {
    const config: DynamicValueConfig = {
      fuente: "custom_field",
      ranges: [{ min: 0, label: "Bajo" }, { min: 80, label: "Alto" }],
    };
    assert.equal(resolveCustomFieldValue(config, "90", 90), "Alto");
  });

  test("legacy config without tipo and no ranges → inferred as texto", () => {
    const config: DynamicValueConfig = {
      fuente: "custom_field",
    };
    assert.equal(resolveCustomFieldValue(config, "some text", "some text"), "some text");
  });

  test("no mode prefix in output (mode eliminated)", () => {
    const config: DynamicValueConfig = {
      fuente: "custom_field",
      tipo: "numero",
      ranges: [{ min: 0, label: "Bajo" }],
    };
    const result = resolveCustomFieldValue(config, "10", 10);
    assert.ok(!result.includes("exacto:"));
    assert.ok(!result.includes("aprox:"));
  });
});

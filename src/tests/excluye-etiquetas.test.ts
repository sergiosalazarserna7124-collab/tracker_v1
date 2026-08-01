import { test, describe } from "node:test";
import assert from "node:assert/strict";

interface AccionRegla {
  tipo: "cambiar_estado" | "asignar_etiqueta" | "etapa_cambiada" | "incrementar_metrica" | "asignar_categoria" | "escribir_campo_ghl" | "escribir_campo_ghl_ia";
  valor?: string;
  fieldId?: string;
  prompt?: string;
  funnelStage?: string;
  metrica_id?: string;
  metrica_incremento?: number;
  categoria_id?: string;
}

interface ReglaEtiquetaNormalized {
  id: string;
  condition: string;
  acciones: AccionRegla[];
  fuentes: string[];
  excluye: string[];
}

interface MatchedRule {
  id: string;
  tag: string;
  funnelStage?: string;
  acciones: AccionRegla[];
}

function normalizeRegla(raw: Record<string, unknown>): ReglaEtiquetaNormalized | null {
  const id = raw.id as string | undefined;
  const condition = (raw.condicion ?? raw.condition) as string | undefined;
  if (typeof id !== "string" || typeof condition !== "string") return null;

  let acciones: AccionRegla[];
  if (Array.isArray(raw.acciones) && raw.acciones.length > 0) {
    acciones = raw.acciones as AccionRegla[];
  } else {
    const tipo = (raw.accion ?? "asignar_etiqueta") as AccionRegla["tipo"];
    acciones = [{
      tipo,
      valor: (raw.valor ?? raw.tag) as string | undefined,
    }];
  }

  let fuentes: string[];
  if (Array.isArray(raw.fuentes) && raw.fuentes.length > 0) {
    fuentes = raw.fuentes as string[];
  } else {
    fuentes = ["todas"];
  }

  let excluye: string[] = [];
  if (Array.isArray(raw.excluye)) {
    excluye = (raw.excluye as unknown[])
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .map((v) => v.trim());
  }

  return { id, condition, acciones, fuentes, excluye };
}

function applySuppression(
  matched: ReglaEtiquetaNormalized[],
): ReglaEtiquetaNormalized[] {
  const suppressed = new Set<string>();
  for (const rule of matched) {
    for (const tag of rule.excluye) {
      suppressed.add(tag);
    }
  }
  if (suppressed.size === 0) return matched;

  return matched.filter((r) => {
    const tagAction = r.acciones.find((a) => a.tipo === "asignar_etiqueta");
    const tagValue = tagAction?.valor?.trim() ?? "";
    return !suppressed.has(tagValue);
  });
}

describe("excluye — normalizeRegla parsing", () => {
  test("parses excluye array from raw regla", () => {
    const raw = {
      id: "r1",
      condicion: "El lead está interesado",
      acciones: [{ tipo: "asignar_etiqueta", valor: "interesadocallai--" }],
      excluye: ["esunbroker--", "no_califica--"],
    };
    const normalized = normalizeRegla(raw);
    assert.ok(normalized);
    assert.deepEqual(normalized.excluye, ["esunbroker--", "no_califica--"]);
  });

  test("defaults excluye to empty array when missing", () => {
    const raw = {
      id: "r2",
      condicion: "Algo",
      acciones: [{ tipo: "asignar_etiqueta", valor: "tag1" }],
    };
    const normalized = normalizeRegla(raw);
    assert.ok(normalized);
    assert.deepEqual(normalized.excluye, []);
  });

  test("filters empty strings and trims whitespace in excluye", () => {
    const raw = {
      id: "r3",
      condicion: "Algo",
      acciones: [{ tipo: "asignar_etiqueta", valor: "tag1" }],
      excluye: ["  esunbroker--  ", "", "  ", "no_califica--"],
    };
    const normalized = normalizeRegla(raw);
    assert.ok(normalized);
    assert.deepEqual(normalized.excluye, ["esunbroker--", "no_califica--"]);
  });

  test("ignores non-array excluye", () => {
    const raw = {
      id: "r4",
      condicion: "Algo",
      acciones: [{ tipo: "asignar_etiqueta", valor: "tag1" }],
      excluye: "not-an-array",
    };
    const normalized = normalizeRegla(raw);
    assert.ok(normalized);
    assert.deepEqual(normalized.excluye, []);
  });

  test("filters non-string values from excluye", () => {
    const raw = {
      id: "r5",
      condicion: "Algo",
      acciones: [{ tipo: "asignar_etiqueta", valor: "tag1" }],
      excluye: ["valid--", 42, null, undefined, "also_valid--"],
    };
    const normalized = normalizeRegla(raw);
    assert.ok(normalized);
    assert.deepEqual(normalized.excluye, ["valid--", "also_valid--"]);
  });
});

describe("excluye — suppression logic", () => {
  test("suppresses contradictory tags (Shark re golden case)", () => {
    const reglas: ReglaEtiquetaNormalized[] = [
      {
        id: "interesado",
        condition: "El lead muestra interés",
        acciones: [{ tipo: "asignar_etiqueta", valor: "interesadocallai--" }],
        fuentes: ["todas"],
        excluye: ["esunbroker--", "no_califica--", "quierevendernosalgo--", "espera-usa-tour"],
      },
      {
        id: "broker",
        condition: "Es un broker",
        acciones: [{ tipo: "asignar_etiqueta", valor: "esunbroker--" }],
        fuentes: ["todas"],
        excluye: [],
      },
      {
        id: "nocalifica",
        condition: "No califica",
        acciones: [{ tipo: "asignar_etiqueta", valor: "no_califica--" }],
        fuentes: ["todas"],
        excluye: [],
      },
      {
        id: "enviar_ig",
        condition: "Enviar instagram",
        acciones: [{ tipo: "asignar_etiqueta", valor: "enviar_instagram" }],
        fuentes: ["todas"],
        excluye: [],
      },
    ];

    const result = applySuppression(reglas);

    const resultTags = result.map((r) =>
      r.acciones.find((a) => a.tipo === "asignar_etiqueta")?.valor,
    );

    assert.ok(!resultTags.includes("esunbroker--"), "esunbroker-- must be suppressed");
    assert.ok(!resultTags.includes("no_califica--"), "no_califica-- must be suppressed");
    assert.ok(resultTags.includes("interesadocallai--"), "interesadocallai-- must survive");
    assert.ok(resultTags.includes("enviar_instagram"), "enviar_instagram must survive");
  });

  test("no suppression when no excluye fields set", () => {
    const reglas: ReglaEtiquetaNormalized[] = [
      {
        id: "a",
        condition: "c",
        acciones: [{ tipo: "asignar_etiqueta", valor: "tag_a" }],
        fuentes: ["todas"],
        excluye: [],
      },
      {
        id: "b",
        condition: "c",
        acciones: [{ tipo: "asignar_etiqueta", valor: "tag_b" }],
        fuentes: ["todas"],
        excluye: [],
      },
    ];
    const result = applySuppression(reglas);
    assert.equal(result.length, 2);
  });

  test("preserves rules with non-tag actions even if tag is suppressed", () => {
    const reglas: ReglaEtiquetaNormalized[] = [
      {
        id: "winner",
        condition: "c",
        acciones: [{ tipo: "asignar_etiqueta", valor: "good--" }],
        fuentes: ["todas"],
        excluye: ["bad--"],
      },
      {
        id: "loser",
        condition: "c",
        acciones: [{ tipo: "asignar_etiqueta", valor: "bad--" }],
        fuentes: ["todas"],
        excluye: [],
      },
      {
        id: "side-effect",
        condition: "c",
        acciones: [{ tipo: "cambiar_estado", valor: "contacted" }],
        fuentes: ["todas"],
        excluye: [],
      },
    ];
    const result = applySuppression(reglas);
    assert.equal(result.length, 2);
    assert.ok(result.some((r) => r.id === "winner"));
    assert.ok(result.some((r) => r.id === "side-effect"));
    assert.ok(!result.some((r) => r.id === "loser"));
  });

  test("mutual exclusion: both rules suppress each other", () => {
    const reglas: ReglaEtiquetaNormalized[] = [
      {
        id: "a",
        condition: "c",
        acciones: [{ tipo: "asignar_etiqueta", valor: "tag_a" }],
        fuentes: ["todas"],
        excluye: ["tag_b"],
      },
      {
        id: "b",
        condition: "c",
        acciones: [{ tipo: "asignar_etiqueta", valor: "tag_b" }],
        fuentes: ["todas"],
        excluye: ["tag_a"],
      },
    ];
    const result = applySuppression(reglas);
    assert.equal(result.length, 0, "mutual exclusion suppresses both");
  });

  test("idempotent: running suppression twice yields same result", () => {
    const reglas: ReglaEtiquetaNormalized[] = [
      {
        id: "a",
        condition: "c",
        acciones: [{ tipo: "asignar_etiqueta", valor: "good--" }],
        fuentes: ["todas"],
        excluye: ["bad--"],
      },
      {
        id: "b",
        condition: "c",
        acciones: [{ tipo: "asignar_etiqueta", valor: "bad--" }],
        fuentes: ["todas"],
        excluye: [],
      },
    ];
    const first = applySuppression(reglas);
    const second = applySuppression(first);
    assert.deepEqual(first, second);
  });
});

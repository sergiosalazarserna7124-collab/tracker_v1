import { test, describe } from "node:test";
import assert from "node:assert/strict";

const VALID_TIPOS = [
  "cambiar_estado",
  "asignar_etiqueta",
  "etapa_cambiada",
  "incrementar_metrica",
  "asignar_categoria",
  "escribir_campo_ghl",
  "escribir_campo_ghl_ia",
] as const;

interface AccionRegla {
  tipo: typeof VALID_TIPOS[number];
  valor?: string;
  fieldId?: string;
  prompt?: string;
  funnelStage?: string;
}

function extractIaGhlActions(
  matchedAcciones: AccionRegla[],
): Array<{ fieldId: string; prompt: string }> {
  const actions: Array<{ fieldId: string; prompt: string }> = [];
  for (const accion of matchedAcciones) {
    if (accion.tipo === "escribir_campo_ghl_ia" && accion.fieldId && accion.prompt) {
      actions.push({ fieldId: accion.fieldId, prompt: accion.prompt });
    }
  }
  return actions;
}

describe("escribir_campo_ghl_ia — action extraction", () => {
  test("extracts IA GHL write from matched action", () => {
    const acciones: AccionRegla[] = [
      { tipo: "escribir_campo_ghl_ia", fieldId: "cf_summary", prompt: "Resume en 1 frase el motivo de interés del lead" },
    ];
    const actions = extractIaGhlActions(acciones);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].fieldId, "cf_summary");
    assert.equal(actions[0].prompt, "Resume en 1 frase el motivo de interés del lead");
  });

  test("skips action when fieldId is missing", () => {
    const acciones: AccionRegla[] = [
      { tipo: "escribir_campo_ghl_ia", prompt: "some prompt" },
    ];
    assert.equal(extractIaGhlActions(acciones).length, 0);
  });

  test("skips action when prompt is missing", () => {
    const acciones: AccionRegla[] = [
      { tipo: "escribir_campo_ghl_ia", fieldId: "cf_summary" },
    ];
    assert.equal(extractIaGhlActions(acciones).length, 0);
  });

  test("does not extract from non-ia action types", () => {
    const acciones: AccionRegla[] = [
      { tipo: "asignar_etiqueta", valor: "hot_lead" },
      { tipo: "escribir_campo_ghl", fieldId: "cf_x", valor: "fixed_value" },
    ];
    assert.equal(extractIaGhlActions(acciones).length, 0);
  });

  test("extracts multiple IA writes from mixed actions", () => {
    const acciones: AccionRegla[] = [
      { tipo: "asignar_etiqueta", valor: "hot_lead" },
      { tipo: "escribir_campo_ghl_ia", fieldId: "cf_summary", prompt: "Resume el interés" },
      { tipo: "escribir_campo_ghl", fieldId: "cf_status", valor: "qualified" },
      { tipo: "escribir_campo_ghl_ia", fieldId: "cf_objection", prompt: "Lista objeciones del lead" },
    ];
    const actions = extractIaGhlActions(acciones);
    assert.equal(actions.length, 2);
    assert.equal(actions[0].fieldId, "cf_summary");
    assert.equal(actions[1].fieldId, "cf_objection");
  });

  test("batches IA writes across multiple rules", () => {
    const rules = [
      {
        acciones: [
          { tipo: "escribir_campo_ghl_ia" as const, fieldId: "cf_a", prompt: "prompt a" },
        ],
      },
      {
        acciones: [
          { tipo: "escribir_campo_ghl_ia" as const, fieldId: "cf_b", prompt: "prompt b" },
          { tipo: "asignar_etiqueta" as const, valor: "tag1" },
        ],
      },
    ];

    const allActions = rules.flatMap((r) => extractIaGhlActions(r.acciones));
    assert.equal(allActions.length, 2);
    assert.deepEqual(allActions, [
      { fieldId: "cf_a", prompt: "prompt a" },
      { fieldId: "cf_b", prompt: "prompt b" },
    ]);
  });
});

describe("AccionRegla type — escribir_campo_ghl_ia", () => {
  test("type includes escribir_campo_ghl_ia", () => {
    assert.ok(VALID_TIPOS.includes("escribir_campo_ghl_ia"));
  });

  test("prompt and fieldId are part of action schema", () => {
    const accion: AccionRegla = {
      tipo: "escribir_campo_ghl_ia",
      fieldId: "contact.custom_field_id",
      prompt: "Resume el motivo de la llamada",
    };
    assert.equal(accion.fieldId, "contact.custom_field_id");
    assert.equal(accion.prompt, "Resume el motivo de la llamada");
    assert.equal(accion.valor, undefined);
  });

  test("coexists with escribir_campo_ghl (fixed value) without interference", () => {
    const acciones: AccionRegla[] = [
      { tipo: "escribir_campo_ghl", fieldId: "cf_status", valor: "qualified" },
      { tipo: "escribir_campo_ghl_ia", fieldId: "cf_summary", prompt: "Resume la llamada" },
    ];
    const iaActions = extractIaGhlActions(acciones);
    assert.equal(iaActions.length, 1);
    assert.equal(iaActions[0].fieldId, "cf_summary");
  });
});

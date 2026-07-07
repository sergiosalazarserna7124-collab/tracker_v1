import { test, describe } from "node:test";
import assert from "node:assert/strict";

const VALID_TIPOS = [
  "cambiar_estado",
  "asignar_etiqueta",
  "etapa_cambiada",
  "incrementar_metrica",
  "asignar_categoria",
  "escribir_campo_ghl",
] as const;

interface AccionRegla {
  tipo: typeof VALID_TIPOS[number];
  valor?: string;
  fieldId?: string;
  funnelStage?: string;
}

function extractGhlWrites(
  matchedAcciones: AccionRegla[],
): Array<{ key: string; field_value: string }> {
  const writes: Array<{ key: string; field_value: string }> = [];
  for (const accion of matchedAcciones) {
    if (accion.tipo === "escribir_campo_ghl" && accion.fieldId && accion.valor) {
      writes.push({ key: accion.fieldId, field_value: accion.valor });
    }
  }
  return writes;
}

describe("escribir_campo_ghl — action extraction", () => {
  test("extracts GHL write from matched action", () => {
    const acciones: AccionRegla[] = [
      { tipo: "escribir_campo_ghl", fieldId: "cf_budget", valor: "Presupuesto_mayor_5000" },
    ];
    const writes = extractGhlWrites(acciones);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], { key: "cf_budget", field_value: "Presupuesto_mayor_5000" });
  });

  test("skips action when fieldId is missing", () => {
    const acciones: AccionRegla[] = [
      { tipo: "escribir_campo_ghl", valor: "some_value" },
    ];
    assert.equal(extractGhlWrites(acciones).length, 0);
  });

  test("skips action when valor is missing", () => {
    const acciones: AccionRegla[] = [
      { tipo: "escribir_campo_ghl", fieldId: "cf_budget" },
    ];
    assert.equal(extractGhlWrites(acciones).length, 0);
  });

  test("does not extract from non-ghl action types", () => {
    const acciones: AccionRegla[] = [
      { tipo: "asignar_etiqueta", valor: "hot_lead" },
      { tipo: "asignar_categoria", valor: "ventas" },
    ];
    assert.equal(extractGhlWrites(acciones).length, 0);
  });

  test("extracts multiple GHL writes from mixed actions", () => {
    const acciones: AccionRegla[] = [
      { tipo: "asignar_etiqueta", valor: "hot_lead" },
      { tipo: "escribir_campo_ghl", fieldId: "cf_status", valor: "qualified" },
      { tipo: "escribir_campo_ghl", fieldId: "cf_source", valor: "inbound_call" },
    ];
    const writes = extractGhlWrites(acciones);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].key, "cf_status");
    assert.equal(writes[1].key, "cf_source");
  });

  test("batches writes into single array for API call", () => {
    const rules = [
      {
        acciones: [
          { tipo: "escribir_campo_ghl" as const, fieldId: "cf_a", valor: "val_a" },
        ],
      },
      {
        acciones: [
          { tipo: "escribir_campo_ghl" as const, fieldId: "cf_b", valor: "val_b" },
          { tipo: "asignar_etiqueta" as const, valor: "tag1" },
        ],
      },
    ];

    const allWrites = rules.flatMap((r) => extractGhlWrites(r.acciones));
    assert.equal(allWrites.length, 2);
    assert.deepEqual(allWrites, [
      { key: "cf_a", field_value: "val_a" },
      { key: "cf_b", field_value: "val_b" },
    ]);
  });
});

describe("AccionRegla type — escribir_campo_ghl", () => {
  test("type includes escribir_campo_ghl", () => {
    assert.ok(VALID_TIPOS.includes("escribir_campo_ghl"));
  });

  test("fieldId is part of action schema", () => {
    const accion: AccionRegla = {
      tipo: "escribir_campo_ghl",
      fieldId: "contact.custom_field_id",
      valor: "written_value",
    };
    assert.equal(accion.fieldId, "contact.custom_field_id");
    assert.equal(accion.valor, "written_value");
  });
});

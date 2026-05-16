/**
 * Tests unitarios para computeChatMetrica
 * Ejecutar con: node --import tsx/esm --test src/tests/chat-metricas.test.ts
 *
 * AUT-193: Tipo chat en MetricaConfig + objeciones AI
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeChatMetrica } from "../services/data/chats.service.js";
import type { MetricaConfigChat } from "../types/metricas.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ROWS = [
  {
    id_evento: 1,
    id_cuenta: 10,
    fecha_y_hora_z: "2025-01-10T10:00:00Z",
    estado: "cerrado",
    origen: "WhatsApp",
    asesor_asignado: "Ana",
    ia_categoria: "prospecto_caliente",
    ia_objeciones: [{ objecion: "es muy caro", categoria: "precio" }],
    tags_internos: ["prioridad_alta", "seguimiento"],
    primer_msg_lead_at: "2025-01-10T10:05:00Z",
  },
  {
    id_evento: 2,
    id_cuenta: 10,
    fecha_y_hora_z: "2025-01-11T09:00:00Z",
    estado: "activo",
    origen: "SMS",
    asesor_asignado: "Pedro",
    ia_categoria: "no_interesado",
    ia_objeciones: [
      { objecion: "no tengo tiempo", categoria: "tiempo" },
      { objecion: "no lo necesito", categoria: "necesidad" },
    ],
    tags_internos: ["seguimiento"],
    primer_msg_lead_at: "2025-01-11T09:03:00Z",
  },
  {
    id_evento: 3,
    id_cuenta: 10,
    fecha_y_hora_z: "2025-01-12T14:00:00Z",
    estado: "cerrado",
    origen: "WhatsApp",
    asesor_asignado: "Ana",
    ia_categoria: "cliente_ganado",
    ia_objeciones: [],
    tags_internos: [],
    primer_msg_lead_at: null,
  },
] as Parameters<typeof computeChatMetrica>[0];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("computeChatMetrica — count", () => {
  test("cuenta todos los chats", () => {
    const config: MetricaConfigChat = {
      id: "m1",
      nombre: "Total chats",
      tipo: "chat",
      chatCampo: "estado",
      chatAgregacion: "count",
    };
    const result = computeChatMetrica(ROWS, config);
    assert.equal(result.valor, 3);
    assert.equal(result.id, "m1");
    assert.equal(result.tipo, "chat");
  });

  test("filtra por valor antes de contar", () => {
    const config: MetricaConfigChat = {
      id: "m2",
      nombre: "Chats cerrados",
      tipo: "chat",
      chatCampo: "estado",
      chatAgregacion: "count",
      chatFiltroValor: "cerrado",
    };
    const result = computeChatMetrica(ROWS, config);
    assert.equal(result.valor, 2);
  });

  test("cuenta 0 si ninguno pasa el filtro", () => {
    const config: MetricaConfigChat = {
      id: "m3",
      nombre: "Chats Email",
      tipo: "chat",
      chatCampo: "origen",
      chatAgregacion: "count",
      chatFiltroValor: "Email",
    };
    const result = computeChatMetrica(ROWS, config);
    assert.equal(result.valor, 0);
  });
});

describe("computeChatMetrica — count_distinct", () => {
  test("cuenta asesores únicos", () => {
    const config: MetricaConfigChat = {
      id: "m4",
      nombre: "Asesores activos",
      tipo: "chat",
      chatCampo: "asesor_asignado",
      chatAgregacion: "count_distinct",
    };
    const result = computeChatMetrica(ROWS, config);
    assert.equal(result.valor, 2); // Ana y Pedro
  });
});

describe("computeChatMetrica — count_by_value", () => {
  test("agrupa chats por origen", () => {
    const config: MetricaConfigChat = {
      id: "m5",
      nombre: "Chats por canal",
      tipo: "chat",
      chatCampo: "origen",
      chatAgregacion: "count_by_value",
    };
    const result = computeChatMetrica(ROWS, config);
    assert.deepEqual(result.valor, { WhatsApp: 2, SMS: 1 });
  });

  test("agrupa objeciones por categoría", () => {
    const config: MetricaConfigChat = {
      id: "m6",
      nombre: "Objeciones por categoría",
      tipo: "chat",
      chatCampo: "ia_objeciones",
      chatAgregacion: "count_by_value",
    };
    const result = computeChatMetrica(ROWS, config);
    const valor = result.valor as Record<string, number>;
    assert.equal(valor.precio, 1);
    assert.equal(valor.tiempo, 1);
    assert.equal(valor.necesidad, 1);
  });

  test("agrupa tags por nombre", () => {
    const config: MetricaConfigChat = {
      id: "m7",
      nombre: "Tags más usados",
      tipo: "chat",
      chatCampo: "tags_internos",
      chatAgregacion: "count_by_value",
    };
    const result = computeChatMetrica(ROWS, config);
    const valor = result.valor as Record<string, number>;
    assert.equal(valor.seguimiento, 2);
    assert.equal(valor.prioridad_alta, 1);
  });
});

describe("computeChatMetrica — avg_response_time", () => {
  test("calcula tiempo promedio de respuesta en minutos", () => {
    // Row 1: 10:05 - 10:00 = 5 min
    // Row 2: 09:03 - 09:00 = 3 min
    // Row 3: primer_msg_lead_at = null → excluido
    const config: MetricaConfigChat = {
      id: "m8",
      nombre: "Tiempo respuesta promedio",
      tipo: "chat",
      chatCampo: "primer_msg_lead_at",
      chatAgregacion: "avg_response_time",
    };
    const result = computeChatMetrica(ROWS, config);
    assert.equal(result.valor, 4); // (5 + 3) / 2 = 4 min
  });

  test("retorna 0 si no hay datos válidos", () => {
    const config: MetricaConfigChat = {
      id: "m9",
      nombre: "Tiempo respuesta promedio",
      tipo: "chat",
      chatCampo: "primer_msg_lead_at",
      chatAgregacion: "avg_response_time",
    };
    const result = computeChatMetrica([], config);
    assert.equal(result.valor, 0);
  });
});

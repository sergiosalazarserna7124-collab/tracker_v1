import { generateObject, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { env } from "../../config/env.js";
import { trackApiUsage, TIPO_CONSUMO } from "./track-api-usage.service.js";
import { getContactById } from "../ghl-api.service.js";
import {
  resolveCustomFieldValue,
  type DynamicValueRange,
  type DynamicValueConfig,
} from "./dynamic-value.utils.js";

// ─── Clientes IA ─────────────────────────────────────────────────────────────

const defaultProvider = createOpenAI({ apiKey: env.OPENAI_API_KEY });
const defaultModel = defaultProvider("gpt-4o-mini");

function resolveModel(openaiApiKey?: string | null): LanguageModel {
  if (openaiApiKey) {
    return createOpenAI({ apiKey: openaiApiKey })("gpt-4o-mini");
  }
  return defaultModel;
}

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface AccionRegla {
  tipo: "cambiar_estado" | "asignar_etiqueta" | "etapa_cambiada" | "incrementar_metrica" | "asignar_categoria";
  valor?: string;
  funnelStage?: string;
  metrica_id?: string;
  metrica_incremento?: number;
  categoria_id?: string;
}

export type { DynamicValueRange, DynamicValueConfig } from "./dynamic-value.utils.js";

export interface DynamicValueContext {
  contactId?: string | null;
  bearerToken?: string | null;
}

export interface ReglaEtiquetaNormalized {
  id: string;
  condition: string;
  acciones: AccionRegla[];
  fuentes: string[];
  dynamicValue?: DynamicValueConfig;
}

export interface MatchedRule {
  id: string;
  tag: string;
  funnelStage?: string;
  acciones: AccionRegla[];
}

export interface ReglasEvalResult {
  matched_tags: string[];
  matched_rules: MatchedRule[];
  matched_categoria: string | null;
}

// ─── Schema de salida IA ─────────────────────────────────────────────────────

const evaluatorSchema = jsonSchema<{ matched_rule_ids: string[] }>({
  type: "object",
  properties: {
    matched_rule_ids: {
      type: "array",
      items: { type: "string" },
      description: "IDs de las reglas cuya condición se cumple en la transcripción",
    },
  },
  required: ["matched_rule_ids"],
  additionalProperties: false,
});

// ─── Prompt del evaluador ────────────────────────────────────────────────────

const EVALUATOR_PROMPT = `Eres un evaluador de reglas de etiquetado para transcripciones de llamadas y videollamadas de ventas. Se te da una transcripción y una lista de REGLAS. Cada regla tiene un "id" y una "condition" (descripción en lenguaje natural de cuándo aplicar esa etiqueta).

Tu tarea EXACTA:
1. Lee la transcripción completa.
2. Evalúa CADA regla: ¿la condición descrita en "condition" se cumple en la transcripción?
3. Devuelve ÚNICAMENTE los IDs de las reglas cuya condición SÍ se cumple.

REGLAS ESTRICTAS:
- NO inventes reglas ni IDs que no estén en la lista.
- Solo evalúa las reglas proporcionadas.
- Si ninguna regla se cumple, devuelve un array vacío [].
- Sé literal al evaluar las condiciones: si la condición dice "menciona atún" y en la transcripción se menciona "atún", eso es un match.
- No hagas interpretaciones rebuscadas; evalúa de forma directa y concreta.`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SOURCE_ALIASES: Record<string, string> = {
  llamadas: "call",
  videollamadas: "meeting",
  chats: "chat",
};

function normalizeSourceValue(raw: string): string {
  const lower = raw.toLowerCase();
  return SOURCE_ALIASES[lower] ?? lower;
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
      funnelStage: raw.funnelStage as string | undefined,
      metrica_id: raw.metrica_id as string | undefined,
      metrica_incremento: raw.metrica_incremento as number | undefined,
    }];
  }

  let fuentes: string[];
  if (Array.isArray(raw.fuentes) && raw.fuentes.length > 0) {
    fuentes = (raw.fuentes as string[]).map(normalizeSourceValue);
  } else {
    const legacy = (raw.fuente ?? raw.source) as string | undefined;
    if (legacy && legacy.toLowerCase() !== "todas") {
      fuentes = [normalizeSourceValue(legacy)];
    } else {
      fuentes = ["todas"];
    }
  }

  const dv = raw.dynamicValue as Record<string, unknown> | undefined;
  let dynamicValue: DynamicValueConfig | undefined;
  if (dv && typeof dv === "object" && (dv.fuente === "custom_field" || dv.fuente === "formula")) {
    const validTipos = ["numero", "si_no", "texto", "fecha"] as const;
    const tipoRaw = dv.tipo as string | undefined;
    const tipo = validTipos.includes(tipoRaw as typeof validTipos[number])
      ? (tipoRaw as DynamicValueConfig["tipo"])
      : undefined;

    dynamicValue = {
      fuente: dv.fuente as DynamicValueConfig["fuente"],
      ...(typeof dv.fieldId === "string" && { fieldId: dv.fieldId }),
      ...(typeof dv.formula === "string" && { formula: dv.formula }),
      ...(tipo && { tipo }),
      ...(Array.isArray(dv.ranges) && {
        ranges: (dv.ranges as DynamicValueRange[]).filter(
          (r) => typeof r.min === "number" && typeof r.label === "string",
        ),
      }),
      ...(typeof dv.labelSi === "string" && { labelSi: dv.labelSi }),
      ...(typeof dv.labelNo === "string" && { labelNo: dv.labelNo }),
    };
  }

  return { id, condition, acciones, fuentes, ...(dynamicValue && { dynamicValue }) };
}

function parseAndNormalizeReglas(raw: unknown): ReglaEtiquetaNormalized[] {
  if (!Array.isArray(raw)) return [];
  const result: ReglaEtiquetaNormalized[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const normalized = normalizeRegla(item as Record<string, unknown>);
    if (normalized) result.push(normalized);
  }
  return result;
}

function filterBySource(reglas: ReglaEtiquetaNormalized[], source: string): ReglaEtiquetaNormalized[] {
  const target = source.toLowerCase();
  return reglas.filter((r) =>
    r.fuentes.includes("todas") || r.fuentes.includes(target),
  );
}

// ─── Dynamic value resolution ───────────────────────────────────────────────

async function resolveDynamicValue(
  config: DynamicValueConfig,
  ctx: DynamicValueContext,
): Promise<string | null> {
  if (config.fuente === "custom_field") {
    if (!config.fieldId || !ctx.contactId || !ctx.bearerToken) return null;
    const contact = await getContactById(ctx.contactId, ctx.bearerToken);
    if (!contact?.customFields) return null;
    const field = contact.customFields.find(
      (f) => f.id === config.fieldId || f.key === config.fieldId,
    );
    if (!field || !field.value) return null;

    return resolveCustomFieldValue(config, String(field.value), field.value);
  }

  return null;
}

// ─── Función principal ───────────────────────────────────────────────────────

export async function evaluateReglas(
  transcript: string,
  reglasRaw: unknown,
  source: "call" | "meeting",
  promptVentas: string | null,
  openaiApiKey?: string | null,
  idCuenta?: number | null,
  dynamicCtx?: DynamicValueContext,
): Promise<ReglasEvalResult> {
  const allReglas = parseAndNormalizeReglas(reglasRaw);
  const reglas = filterBySource(allReglas, source);

  if (!reglas.length || !transcript.trim()) {
    return { matched_tags: [], matched_rules: [], matched_categoria: null };
  }

  const model = resolveModel(openaiApiKey);

  const reglasForPrompt = reglas.map((r) => ({
    id: r.id,
    condition: r.condition,
  }));

  let systemPrompt = EVALUATOR_PROMPT;
  if (promptVentas) {
    systemPrompt = `Contexto de la empresa: ${promptVentas}\n\n${systemPrompt}`;
  }

  const { object, usage } = await generateObject({
    model,
    schema: evaluatorSchema,
    system: systemPrompt,
    prompt: `REGLAS A EVALUAR:\n${JSON.stringify(reglasForPrompt, null, 2)}\n\nTRANSCRIPCIÓN:\n${transcript}`,
    temperature: 0,
  });

  void trackApiUsage(idCuenta, TIPO_CONSUMO.GPT4O_MINI, usage.totalTokens ?? 0);

  const matchedIds = new Set(object.matched_rule_ids);
  const matched = reglas.filter((r) => matchedIds.has(r.id));

  // Resolve dynamic values for matched rules
  const dynamicResolutions = new Map<string, string>();
  if (dynamicCtx) {
    const dynamicRules = matched.filter((r) => r.dynamicValue);
    if (dynamicRules.length > 0) {
      const results = await Promise.allSettled(
        dynamicRules.map(async (r) => {
          const val = await resolveDynamicValue(r.dynamicValue!, dynamicCtx);
          if (val) dynamicResolutions.set(r.id, val);
        }),
      );
      for (const r of results) {
        if (r.status === "rejected") {
          console.error("[ReglaEval] Error resolviendo dynamic value:", r.reason);
        }
      }
    }
  }

  const tags: string[] = [];
  let matchedCategoria: string | null = null;
  for (const rule of matched) {
    const dynamicVal = dynamicResolutions.get(rule.id);
    for (const accion of rule.acciones) {
      if (accion.tipo === "asignar_etiqueta") {
        if (dynamicVal) {
          const baseTag = accion.valor?.trim() ? `${accion.valor}: ${dynamicVal}` : dynamicVal;
          tags.push(baseTag);
        } else if (accion.valor && accion.valor.trim() !== "") {
          tags.push(accion.valor);
        }
      }
      if (accion.tipo === "asignar_categoria" && accion.categoria_id && !matchedCategoria) {
        matchedCategoria = accion.categoria_id;
      }
    }
  }

  return {
    matched_tags: tags,
    matched_rules: matched.map((r) => {
      const tagAction = r.acciones.find((a) => a.tipo === "asignar_etiqueta");
      const stageAction = r.acciones.find((a) => a.funnelStage);
      const dynamicVal = dynamicResolutions.get(r.id);
      let tag = tagAction?.valor ?? "";
      if (dynamicVal) {
        tag = tag.trim() ? `${tag}: ${dynamicVal}` : dynamicVal;
      }
      return {
        id: r.id,
        tag,
        ...(stageAction?.funnelStage && { funnelStage: stageAction.funnelStage }),
        acciones: r.acciones,
      };
    }),
    matched_categoria: matchedCategoria,
  };
}

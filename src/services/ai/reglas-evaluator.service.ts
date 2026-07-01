import { generateObject, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { env } from "../../config/env.js";
import { trackApiUsage, TIPO_CONSUMO } from "./track-api-usage.service.js";

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
  tipo: "cambiar_estado" | "asignar_etiqueta" | "etapa_cambiada" | "incrementar_metrica";
  valor?: string;
  funnelStage?: string;
  metrica_id?: string;
  metrica_incremento?: number;
}

export interface ReglaEtiquetaNormalized {
  id: string;
  condition: string;
  acciones: AccionRegla[];
  fuentes: string[];
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

  // Normalize acciones: prefer new shape, fall back to legacy single-action
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

  // Normalize fuentes: prefer new shape, fall back to legacy single source
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

  return { id, condition, acciones, fuentes };
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

// ─── Función principal ───────────────────────────────────────────────────────

export async function evaluateReglas(
  transcript: string,
  reglasRaw: unknown,
  source: "call" | "meeting",
  promptVentas: string | null,
  openaiApiKey?: string | null,
  idCuenta?: number | null,
): Promise<ReglasEvalResult> {
  const allReglas = parseAndNormalizeReglas(reglasRaw);
  const reglas = filterBySource(allReglas, source);

  if (!reglas.length || !transcript.trim()) {
    return { matched_tags: [], matched_rules: [] };
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

  // Collect tags from all asignar_etiqueta actions across all matched rules
  const tags: string[] = [];
  for (const rule of matched) {
    for (const accion of rule.acciones) {
      if (accion.tipo === "asignar_etiqueta" && accion.valor && accion.valor.trim() !== "") {
        tags.push(accion.valor);
      }
    }
  }

  return {
    matched_tags: tags,
    matched_rules: matched.map((r) => {
      const tagAction = r.acciones.find((a) => a.tipo === "asignar_etiqueta");
      const stageAction = r.acciones.find((a) => a.funnelStage);
      return {
        id: r.id,
        tag: tagAction?.valor ?? "",
        ...(stageAction?.funnelStage && { funnelStage: stageAction.funnelStage }),
        acciones: r.acciones,
      };
    }),
  };
}

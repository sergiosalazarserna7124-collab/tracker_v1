import { generateObject, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { env } from "../../config/env.js";

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

export interface ReglaEtiqueta {
  id: string;
  tag: string;
  source: string;
  condition: string;
  funnelStage?: string;
}

export interface ReglasEvalResult {
  matched_tags: string[];
  matched_rules: { id: string; tag: string; funnelStage?: string }[];
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

function parseReglas(raw: unknown): ReglaEtiqueta[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is ReglaEtiqueta =>
      typeof r === "object" &&
      r !== null &&
      typeof r.id === "string" &&
      typeof r.tag === "string" &&
      typeof r.source === "string" &&
      typeof r.condition === "string",
  );
}

function filterBySource(reglas: ReglaEtiqueta[], source: string): ReglaEtiqueta[] {
  return reglas.filter((r) => r.source.toLowerCase() === source.toLowerCase());
}

// ─── Función principal ───────────────────────────────────────────────────────

export async function evaluateReglas(
  transcript: string,
  reglasRaw: unknown,
  source: "call" | "meeting",
  promptVentas: string | null,
  openaiApiKey?: string | null,
): Promise<ReglasEvalResult> {
  const allReglas = parseReglas(reglasRaw);
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

  const { object } = await generateObject({
    model,
    schema: evaluatorSchema,
    system: systemPrompt,
    prompt: `REGLAS A EVALUAR:\n${JSON.stringify(reglasForPrompt, null, 2)}\n\nTRANSCRIPCIÓN:\n${transcript}`,
    temperature: 0,
  });

  const matchedIds = new Set(object.matched_rule_ids);
  const matched = reglas.filter((r) => matchedIds.has(r.id));

  return {
    matched_tags: matched.map((r) => r.tag).filter((t) => t.trim() !== ""),
    matched_rules: matched.map((r) => ({
      id: r.id,
      tag: r.tag,
      ...(r.funnelStage && { funnelStage: r.funnelStage }),
    })),
  };
}

import { generateObject, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { env } from "../../config/env.js";
import { trackApiUsage, TIPO_CONSUMO } from "./track-api-usage.service.js";
import type { SeccionGuion, CanalCoach } from "../data/coach-guion.service.js";

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface ScoreSeccion {
  seccion_id: string;
  score: number;
  cumple: boolean;
  observacion: string;
}

export interface CoachEvaluationResult {
  scores: ScoreSeccion[];
  score_total: number;
  cumple_umbral: boolean;
  secciones_faltantes_must_have: string[];
  nota_accionable: string;
}

// ─── Clientes IA ─────────────────────────────────────────────────────────────

const defaultProvider = createOpenAI({ apiKey: env.OPENAI_API_KEY });
const defaultModel = defaultProvider("gpt-4o-mini");

function resolveModel(openaiApiKey?: string | null): LanguageModel {
  if (openaiApiKey) {
    return createOpenAI({ apiKey: openaiApiKey })("gpt-4o-mini");
  }
  return defaultModel;
}

// ─── Schema para structured output ──────────────────────────────────────────

function buildEvalSchema(seccionIds: string[]) {
  return jsonSchema<{
    scores: Array<{
      seccion_id: string;
      score: number;
      cumple: boolean;
      observacion: string;
    }>;
    nota_accionable: string;
  }>({
    type: "object",
    properties: {
      scores: {
        type: "array",
        items: {
          type: "object",
          properties: {
            seccion_id: {
              type: "string",
              enum: seccionIds,
              description: "ID de la sección evaluada",
            },
            score: {
              type: "number",
              minimum: 0,
              maximum: 100,
              description: "Puntuación 0-100 de qué tan bien el asesor cubrió esta sección",
            },
            cumple: {
              type: "boolean",
              description: "true si el asesor cubrió satisfactoriamente esta sección",
            },
            observacion: {
              type: "string",
              description: "Observación breve sobre el desempeño en esta sección",
            },
          },
          required: ["seccion_id", "score", "cumple", "observacion"],
          additionalProperties: false,
        },
      },
      nota_accionable: {
        type: "string",
        description: "1-2 mejoras concretas y accionables para el asesor (máximo 2 oraciones)",
      },
    },
    required: ["scores", "nota_accionable"],
    additionalProperties: false,
  });
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

const CANAL_LABELS: Record<CanalCoach, { tipo: string; interaccion: string }> = {
  llamada: { tipo: "llamada telefónica", interaccion: "llamada" },
  chat: { tipo: "conversación de chat", interaccion: "chat" },
  videollamada: { tipo: "videollamada", interaccion: "videollamada" },
};

function buildSystemPrompt(secciones: SeccionGuion[], canal: CanalCoach = "llamada"): string {
  const seccionesDesc = secciones.map((s) => {
    const tipo = s.tipo === "must_have" ? "OBLIGATORIA" : "DESEABLE";
    return `- **${s.nombre}** (ID: ${s.id}, ${tipo}): ${s.criterio}`;
  }).join("\n");

  const labels = CANAL_LABELS[canal];

  return `Eres un evaluador de ${labels.tipo}s de ventas. Tu tarea es evaluar una transcripción contra un guion de ventas específico.

## SECCIONES DEL GUION A EVALUAR

${seccionesDesc}

## INSTRUCCIONES

1. Evalúa CADA sección del guion y asigna un score de 0 a 100.
2. "cumple" = true si el asesor cubrió al menos el criterio mínimo de esa sección (score ≥ 50).
3. Sé justo: no exijas coincidencia literal, evalúa si el OBJETIVO de la sección se cumplió.
4. La nota_accionable debe ser concreta y útil: máximo 1-2 mejoras específicas que el asesor pueda aplicar en su próxima ${labels.interaccion}. No repitas todo el guion; enfócate en lo más impactante.
5. Si el asesor hizo bien todo, la nota puede ser un refuerzo positivo breve.

## REGLAS
- Score 0-30: No se mencionó o se hizo muy mal
- Score 31-60: Se mencionó parcialmente o de forma débil
- Score 61-80: Se cubrió razonablemente bien
- Score 81-100: Excelente ejecución
- La nota_accionable NO debe ser un checklist. Máximo 2 oraciones, enfocadas en la mejora más importante.`;
}

// ─── Evaluación principal ───────────────────────────────────────────────────

export async function evaluateCallAgainstGuion(
  transcript: string,
  secciones: SeccionGuion[],
  umbral: number,
  openaiApiKey?: string | null,
  idCuenta?: number | null,
  canal: CanalCoach = "llamada",
): Promise<CoachEvaluationResult> {
  const model = resolveModel(openaiApiKey);
  const seccionIds = secciones.map((s) => s.id);
  const schema = buildEvalSchema(seccionIds);
  const systemPrompt = buildSystemPrompt(secciones, canal);
  const labels = CANAL_LABELS[canal];

  const { object, usage } = await generateObject({
    model,
    schema,
    system: systemPrompt,
    prompt: `Evalúa la siguiente transcripción de ${labels.tipo} contra el guion:\n\n${transcript}`,
    temperature: 0,
  });

  void trackApiUsage(idCuenta, TIPO_CONSUMO.GPT4O_MINI, usage.totalTokens ?? 0);

  const scoresMap = new Map(object.scores.map((s) => [s.seccion_id, s]));
  const scores: ScoreSeccion[] = secciones.map((sec) => {
    const evaluated = scoresMap.get(sec.id);
    return {
      seccion_id: sec.id,
      score: evaluated?.score ?? 0,
      cumple: evaluated?.cumple ?? false,
      observacion: evaluated?.observacion ?? "No evaluado",
    };
  });

  const totalScore = scores.length > 0
    ? Math.round(scores.reduce((sum, s) => sum + s.score, 0) / scores.length)
    : 0;

  const mustHaveFailing = secciones
    .filter((sec) => sec.tipo === "must_have")
    .filter((sec) => {
      const s = scores.find((sc) => sc.seccion_id === sec.id);
      return !s?.cumple;
    })
    .map((sec) => sec.id);

  return {
    scores,
    score_total: totalScore,
    cumple_umbral: totalScore >= umbral && mustHaveFailing.length === 0,
    secciones_faltantes_must_have: mustHaveFailing,
    nota_accionable: object.nota_accionable,
  };
}

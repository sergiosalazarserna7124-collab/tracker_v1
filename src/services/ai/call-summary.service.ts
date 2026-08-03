import { generateObject, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { env } from "../../config/env.js";
import { trackApiUsage, TIPO_CONSUMO } from "./track-api-usage.service.js";

const defaultProvider = createOpenAI({ apiKey: env.OPENAI_API_KEY });
const defaultModel = defaultProvider("gpt-4o-mini");

function resolveModel(openaiApiKey?: string | null): LanguageModel {
  if (openaiApiKey) {
    return createOpenAI({ apiKey: openaiApiKey })("gpt-4o-mini");
  }
  return defaultModel;
}

export interface CallSummary {
  interes_lead: string;
  ubicacion: string;
  presupuesto: string;
  quien_decide: string;
  tiempo_compra: string;
  desenlace: string;
}

const summarySchema = jsonSchema<CallSummary>({
  type: "object",
  properties: {
    interes_lead: {
      type: "string",
      description: "Qué busca o le interesa al prospecto: tipo de propiedad, zona, características. Si no se menciona, responder 'No mencionado'.",
    },
    ubicacion: {
      type: "string",
      description: "Dónde vive o se ubica actualmente el prospecto. Si no se menciona, responder 'No mencionado'.",
    },
    presupuesto: {
      type: "string",
      description: "Rango de presupuesto o monto que maneja el prospecto. Si no se menciona, responder 'No mencionado'.",
    },
    quien_decide: {
      type: "string",
      description: "Con quién toma la decisión de compra (solo, pareja, socio, familia, etc.). Si no se menciona, responder 'No mencionado'.",
    },
    tiempo_compra: {
      type: "string",
      description: "En cuánto tiempo planea comprar o tomar la decisión (inmediato, 1 mes, 3 meses, etc.). Si no se menciona, responder 'No mencionado'.",
    },
    desenlace: {
      type: "string",
      description: "En qué terminó la llamada: se agendó cita, pidió más info, no le interesó, va a pensarlo, etc.",
    },
  },
  required: ["interes_lead", "ubicacion", "presupuesto", "quien_decide", "tiempo_compra", "desenlace"],
  additionalProperties: false,
});

const SYSTEM_PROMPT = `Eres un sistema de extracción de información de llamadas de ventas inmobiliarias.

Analiza la transcripción y extrae estos 6 campos:

1. **interes_lead**: ¿Qué le interesa al prospecto? Qué tipo de propiedad busca, en qué zona, qué características pide.
2. **ubicacion**: ¿Dónde vive actualmente el prospecto? Ciudad, estado, colonia, país.
3. **presupuesto**: ¿Cuánto puede o quiere invertir? Rango, monto específico, crédito.
4. **quien_decide**: ¿Con quién toma la decisión de compra? Solo, con su pareja, socio, familia, etc.
5. **tiempo_compra**: ¿En cuánto tiempo planea comprar o tomar la decisión? Inmediato, 1 mes, 3 meses, sin prisa, etc.
6. **desenlace**: ¿En qué terminó la llamada? Se agendó cita, pidió más información, no le interesó, quedó en pensarlo, colgó, etc.

REGLAS:
- Sé conciso: cada campo debe ser 1-2 oraciones máximo.
- Si un dato NO se menciona en la transcripción, responder exactamente "No mencionado".
- NUNCA inventes información que no esté en la transcripción.
- Usa el lenguaje natural del prospecto cuando sea posible (citar brevemente).`;

export async function extractCallSummary(
  transcript: string,
  openaiApiKey?: string | null,
  idCuenta?: number | null,
): Promise<CallSummary | null> {
  if (!transcript.trim() || transcript.trim().length < 100) return null;

  const model = resolveModel(openaiApiKey);

  try {
    const { object, usage } = await Promise.race([
      generateObject({
        model,
        schema: summarySchema,
        system: SYSTEM_PROMPT,
        prompt: `Transcripción de la llamada:\n\n${transcript}`,
        temperature: 0,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("call-summary extraction timeout")), 12_000),
      ),
    ]);

    void trackApiUsage(idCuenta, TIPO_CONSUMO.GPT4O_MINI, usage.totalTokens ?? 0);

    return object;
  } catch (err) {
    console.warn(
      `[CallSummary] Extraction failed (fail-open):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

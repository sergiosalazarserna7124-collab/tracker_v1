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
  ubicacion: string;
  objetivo: string;
  presupuesto: string;
  quien_decide: string;
  desenlace: string;
}

const summarySchema = jsonSchema<CallSummary>({
  type: "object",
  properties: {
    ubicacion: {
      type: "string",
      description: "Dónde vive o se ubica el prospecto. Si no se menciona, responder 'No mencionado'.",
    },
    objetivo: {
      type: "string",
      description: "Para qué quiere la propiedad o producto (inversión, vivienda, renta, etc.). Si no se menciona, responder 'No mencionado'.",
    },
    presupuesto: {
      type: "string",
      description: "Rango de presupuesto o monto que maneja el prospecto. Si no se menciona, responder 'No mencionado'.",
    },
    quien_decide: {
      type: "string",
      description: "Con quién toma la decisión de compra (solo, pareja, socio, familia, etc.). Si no se menciona, responder 'No mencionado'.",
    },
    desenlace: {
      type: "string",
      description: "En qué terminó la llamada: se agendó cita, pidió más info, no le interesó, va a pensarlo, etc.",
    },
  },
  required: ["ubicacion", "objetivo", "presupuesto", "quien_decide", "desenlace"],
  additionalProperties: false,
});

const SYSTEM_PROMPT = `Eres un sistema de extracción de información de llamadas de ventas inmobiliarias.

Analiza la transcripción y extrae estos 5 campos:

1. **ubicacion**: ¿Dónde vive o se ubica el prospecto? Ciudad, estado, colonia, país.
2. **objetivo**: ¿Para qué quiere la propiedad? Inversión, vivienda propia, renta, segunda casa, etc.
3. **presupuesto**: ¿Cuánto puede o quiere invertir? Rango, monto específico, crédito.
4. **quien_decide**: ¿Con quién toma la decisión? Solo, con su pareja, socio, familia, etc.
5. **desenlace**: ¿En qué terminó la llamada? Se agendó cita, pidió más información, no le interesó, quedó en pensarlo, colgó, etc.

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

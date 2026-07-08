import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../../config/env.js";
import { trackApiUsage, TIPO_CONSUMO } from "./track-api-usage.service.js";

// gemini-2.0-flash fue retirado por Google (generateContent → 404 "no longer available").
// gemini-2.5-flash es el modelo flash estable vigente y verificado con la key de prod.
const GEMINI_MODEL = "gemini-2.5-flash";

export interface GeminiEnrichment {
  tono_lead: "positivo" | "neutro" | "negativo" | "hostil";
  recepcion_lead: "abierto" | "interesado" | "indiferente" | "resistente" | "hostil";
  aceptacion_propuesta: "aceptó" | "considerando" | "rechazó" | "no_hubo_propuesta";
  engagement: "alto" | "medio" | "bajo";
  calidad_cierre: "excelente" | "bueno" | "regular" | "malo" | "no_aplica";
  motivo_compra: string | null;
  perfil_compra: string | null;
  edad_estimada: string | null;
  presupuesto_detectado: string | null;
  razon_calificacion: string | null;
  frases_relevantes: string[];
}

const SYSTEM_PROMPT = `Eres un analista de ventas experto. Analiza la siguiente conversación comercial y extrae información estructurada sobre el lead.

Responde SOLO con un JSON válido (sin markdown, sin backticks) con esta estructura exacta:
{
  "tono_lead": "positivo" | "neutro" | "negativo" | "hostil",
  "recepcion_lead": "abierto" | "interesado" | "indiferente" | "resistente" | "hostil",
  "aceptacion_propuesta": "aceptó" | "considerando" | "rechazó" | "no_hubo_propuesta",
  "engagement": "alto" | "medio" | "bajo",
  "calidad_cierre": "excelente" | "bueno" | "regular" | "malo" | "no_aplica",
  "motivo_compra": "string o null",
  "perfil_compra": "string o null",
  "edad_estimada": "rango como '25-35' o null",
  "presupuesto_detectado": "string con moneda o null",
  "razon_calificacion": "string o null",
  "frases_relevantes": ["hasta 5 citas textuales del lead"]
}

REGLAS:
- Basa tu análisis SOLO en lo que dice el texto. No inventes datos.
- Si un campo no se puede determinar, usa null.
- Las frases_relevantes deben ser citas textuales del lead (máximo 5).
- Para edad_estimada, solo inferir si hay pistas claras.
- Para presupuesto_detectado, incluir moneda si se menciona.
- razon_calificacion debe explicar en una oración por qué el lead es o no un buen prospecto.`;

const VALID_TONO = new Set(["positivo", "neutro", "negativo", "hostil"]);
const VALID_RECEPCION = new Set(["abierto", "interesado", "indiferente", "resistente", "hostil"]);
const VALID_ACEPTACION = new Set(["aceptó", "considerando", "rechazó", "no_hubo_propuesta"]);
const VALID_ENGAGEMENT = new Set(["alto", "medio", "bajo"]);
const VALID_CIERRE = new Set(["excelente", "bueno", "regular", "malo", "no_aplica"]);

function validateEnrichment(obj: unknown): GeminiEnrichment | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (!VALID_TONO.has(o.tono_lead as string)) return null;
  if (!VALID_RECEPCION.has(o.recepcion_lead as string)) return null;
  if (!VALID_ACEPTACION.has(o.aceptacion_propuesta as string)) return null;
  if (!VALID_ENGAGEMENT.has(o.engagement as string)) return null;
  if (!VALID_CIERRE.has(o.calidad_cierre as string)) return null;
  if (!Array.isArray(o.frases_relevantes)) return null;
  return {
    tono_lead: o.tono_lead as GeminiEnrichment["tono_lead"],
    recepcion_lead: o.recepcion_lead as GeminiEnrichment["recepcion_lead"],
    aceptacion_propuesta: o.aceptacion_propuesta as GeminiEnrichment["aceptacion_propuesta"],
    engagement: o.engagement as GeminiEnrichment["engagement"],
    calidad_cierre: o.calidad_cierre as GeminiEnrichment["calidad_cierre"],
    motivo_compra: typeof o.motivo_compra === "string" ? o.motivo_compra : null,
    perfil_compra: typeof o.perfil_compra === "string" ? o.perfil_compra : null,
    edad_estimada: typeof o.edad_estimada === "string" ? o.edad_estimada : null,
    presupuesto_detectado: typeof o.presupuesto_detectado === "string" ? o.presupuesto_detectado : null,
    razon_calificacion: typeof o.razon_calificacion === "string" ? o.razon_calificacion : null,
    frases_relevantes: (o.frases_relevantes as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 5),
  };
}

export async function enrichWithGemini(
  transcript: string,
  canal: "llamada" | "videollamada" | "chat",
  idCuenta: number | null,
): Promise<GeminiEnrichment | null> {
  if (!env.GEMINI_API_KEY || !transcript || transcript.length < 50) return null;

  try {
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      generationConfig: { responseMimeType: "application/json" },
    });

    const result = await model.generateContent(
      `${SYSTEM_PROMPT}\n\nCanal: ${canal}\n\nTranscripción:\n${transcript.slice(0, 15_000)}`,
    );

    const response = result.response;
    const text = response.text();
    const tokens = response.usageMetadata?.totalTokenCount ?? 0;

    if (tokens > 0) {
      trackApiUsage(idCuenta, TIPO_CONSUMO.GEMINI_FLASH, tokens).catch(() => {});
    }

    const parsed = JSON.parse(text);
    return validateEnrichment(parsed);
  } catch (err) {
    console.error(`[GeminiEnrichment] Error enriqueciendo ${canal} para cuenta ${idCuenta}:`, err);
    return null;
  }
}

export function estimateDurationFromTranscript(
  transcript: Array<{ timestamp?: string; time?: string }> | string | null | undefined,
): number | null {
  if (!transcript) return null;

  if (typeof transcript === "string") {
    const timeRegex = /(\d{1,2}):(\d{2})(?::(\d{2}))?/g;
    let maxSeconds = 0;
    let match: RegExpExecArray | null;
    while ((match = timeRegex.exec(transcript)) !== null) {
      const h = parseInt(match[1], 10);
      const m = parseInt(match[2], 10);
      const s = match[3] ? parseInt(match[3], 10) : 0;
      const total = h * 3600 + m * 60 + s;
      if (total > maxSeconds) maxSeconds = total;
    }
    return maxSeconds > 0 ? maxSeconds : null;
  }

  if (!Array.isArray(transcript) || transcript.length === 0) return null;

  let maxSeconds = 0;
  for (const entry of transcript) {
    const ts = entry.timestamp ?? entry.time;
    if (!ts) continue;
    const parts = ts.split(":").map(Number);
    if (parts.some(isNaN)) continue;
    const total =
      parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts.length === 2
          ? parts[0] * 60 + parts[1]
          : 0;
    if (total > maxSeconds) maxSeconds = total;
  }
  return maxSeconds > 0 ? maxSeconds : null;
}

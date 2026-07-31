import { generateObject, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { env } from "../../config/env.js";
import { trackApiUsage, TIPO_CONSUMO } from "./track-api-usage.service.js";

// ─── Clientes IA ────────────────────────────────────────────────────────────

const defaultProvider = createOpenAI({ apiKey: env.OPENAI_API_KEY });
const defaultModel = defaultProvider("gpt-4o-mini");

function resolveModel(openaiApiKey?: string | null): LanguageModel {
  if (openaiApiKey) {
    return createOpenAI({ apiKey: openaiApiKey })("gpt-4o-mini");
  }
  return defaultModel;
}

// ─── Feature gate (GLOBAL — habilitado para todas las cuentas) ──────────────
// Anteriormente gateado a cuentas específicas (Set<number>). Ahora global.
// Exportado por retrocompatibilidad con los imports existentes — siempre true.

// ─── Tipos ──────────────────────────────────────────────────────────────────

export interface CitaTareaExtraction {
  cita: {
    detectada: boolean;
    fecha_hora: string | null;
    descripcion: string | null;
  };
  tarea: {
    detectada: boolean;
    titulo: string | null;
    descripcion: string | null;
    fecha_vencimiento: string | null;
    callback_datetime: string | null;
    contexto_lead: string | null;
  };
}

// ─── Schema ─────────────────────────────────────────────────────────────────

const extractionSchema = jsonSchema<CitaTareaExtraction>({
  type: "object",
  properties: {
    cita: {
      type: "object",
      properties: {
        detectada: { type: "boolean", description: "true si se detecta una cita/reunión/visita con fecha y hora concreta" },
        fecha_hora: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "Fecha y hora de la cita en formato ISO 8601 (YYYY-MM-DDTHH:mm:ss). Usar la fecha de la llamada como ancla para referencias relativas.",
        },
        descripcion: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "Breve descripción de la cita (ej: 'Visita al showroom', 'Reunión virtual')",
        },
      },
      required: ["detectada", "fecha_hora", "descripcion"],
      additionalProperties: false,
    },
    tarea: {
      type: "object",
      properties: {
        detectada: { type: "boolean", description: "true si se detecta una tarea o acción de seguimiento pendiente" },
        titulo: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "Título corto de la tarea (ej: 'Enviar catálogo por WhatsApp')",
        },
        descripcion: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "Descripción de la tarea con contexto del lead",
        },
        fecha_vencimiento: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "Fecha de vencimiento en formato ISO 8601 (YYYY-MM-DDTHH:mm:ss). Usar heurística si no es explícita.",
        },
        callback_datetime: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "Fecha y hora en que el lead pidió que le devuelvan la llamada (ej: 'llámame mañana a las 3', 'después de las 5'). ISO 8601 local (YYYY-MM-DDTHH:mm:ss). null si no pidió callback.",
        },
        contexto_lead: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "Resumen breve (1-2 oraciones) de qué quiere el lead y qué se discutió. Ej: 'Interesado en departamento de 2 recámaras, pidió cotización con financiamiento'.",
        },
      },
      required: ["detectada", "titulo", "descripcion", "fecha_vencimiento", "callback_datetime", "contexto_lead"],
      additionalProperties: false,
    },
  },
  required: ["cita", "tarea"],
  additionalProperties: false,
});

// ─── Prompt ─────────────────────────────────────────────────────────────────

function buildPrompt(callDateISO: string, timezone: string): string {
  return `Eres un sistema de extracción de citas y tareas de llamadas telefónicas.

Analiza la transcripción y extrae:

## CITA
Una cita es una reunión, visita, o encuentro con fecha y hora concreta mencionada en la llamada.
- Solo marcar detectada=true si hay una fecha/hora específica o una referencia temporal clara.
- Convertir referencias relativas usando la fecha de la llamada (${callDateISO}, timezone ${timezone}) como ancla:
  - "mañana a las 3" → día siguiente a la llamada, 15:00
  - "el lunes" → próximo lunes desde la fecha de la llamada
  - "hoy a las 9pm" → mismo día, 21:00
  - "pasado mañana" → +2 días
  - "la próxima semana" → +7 días, 10:00 (hora por defecto)
- Si no hay hora específica, usar 10:00 como hora por defecto.
- Devolver fecha_hora en formato ISO 8601 local (YYYY-MM-DDTHH:mm:ss), NO UTC.

## TAREA
Una tarea es una acción de seguimiento que el vendedor debe realizar.
- Ejemplos: enviar información, hacer otra llamada, enviar cotización, mandar fotos, etc.
- Solo marcar detectada=true si hay una acción concreta mencionada.
- Heurística de fechas de vencimiento cuando no es explícita:
  - "en unos días" → +7 días
  - "luego" / "después" → +3 días
  - "mañana" → +1 día
  - Acción sin fecha → +3 días (fecha tentativa)
- Devolver fecha_vencimiento en formato ISO 8601 local (YYYY-MM-DDTHH:mm:ss).

### callback_datetime
Si el lead pide explícitamente que le devuelvan la llamada en un momento específico:
- "llámame mañana a las 3" → día siguiente, 15:00
- "después de las 5" → mismo día (o siguiente si ya pasaron las 5), 17:00
- "llámame el lunes" → próximo lunes, 10:00 (hora por defecto)
- "llámame después" / "ahorita no puedo" → null (no hay hora concreta)
Solo llenar si hay una referencia temporal específica. Si solo dice "después" sin hora, dejar null.

### contexto_lead
Resumen breve (1-2 oraciones) de lo que quiere el lead y lo más relevante que se discutió.
Incluir: interés del lead, producto/servicio mencionado, objeciones principales, siguiente paso acordado.
Ejemplo: "Interesado en departamento de 2 recámaras en zona norte. Pidió cotización con opciones de financiamiento."

## REGLAS
1. Si NO hay cita ni tarea → ambos detectada=false con campos null.
2. No inventar citas o tareas que no estén en la conversación.
3. Sé conservador: si no es claro, no lo extraigas.
4. contexto_lead debe llenarse SIEMPRE que tarea.detectada=true, incluso si el contexto es breve.`;
}

// ─── Extracción principal ───────────────────────────────────────────────────

export async function extractCitaTarea(
  transcript: string,
  callDate: Date,
  timezone: string,
  openaiApiKey?: string | null,
  idCuenta?: number | null,
): Promise<CitaTareaExtraction | null> {
  if (!transcript.trim() || transcript.trim().length < 100) return null;

  const model = resolveModel(openaiApiKey);
  const callDateISO = callDate.toISOString().slice(0, 19);

  try {
    const { object, usage } = await Promise.race([
      generateObject({
        model,
        schema: extractionSchema,
        system: buildPrompt(callDateISO, timezone),
        prompt: `Transcripción de la llamada:\n\n${transcript}`,
        temperature: 0,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("cita-tarea extraction timeout")), 10_000),
      ),
    ]);

    void trackApiUsage(idCuenta, TIPO_CONSUMO.GPT4O_MINI, usage.totalTokens ?? 0);

    if (!object.cita.detectada && !object.tarea.detectada) return null;

    return object;
  } catch (err) {
    console.warn(
      `[CitaTarea] Extraction failed (fail-open):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

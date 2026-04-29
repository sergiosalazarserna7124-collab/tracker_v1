import { generateObject, generateText, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { env } from "../../config/env.js";
import { evaluateReglas, type ReglasEvalResult } from "./reglas-evaluator.service.js";

// ─── Clientes IA (singleton global — fallback) ──────────────────────────────

const defaultProvider = createOpenAI({ apiKey: env.OPENAI_API_KEY });
const defaultModel = defaultProvider("gpt-4o-mini");

function resolveModel(openaiApiKey?: string | null): LanguageModel {
  if (openaiApiKey) {
    return createOpenAI({ apiKey: openaiApiKey })("gpt-4o-mini");
  }
  return defaultModel;
}

// ─── Tipos de salida ──────────────────────────────────────────────────────────

export interface ClassifierResult {
  categoria: string;
  cash_collected: string;
  facturacion: string;
}

export interface ObjecionItem {
  objecion: string;
  categoria: string;
}

export interface CallAnalysisResult {
  classifier: ClassifierResult | null;
  analysisText: string | null;
  objections: ObjecionItem[] | null;
  reglasResult: ReglasEvalResult;
}

// ─── Helper: inyectar contexto de empresa del tenant ─────────────────────────

function withBusinessContext(basePrompt: string, promptVentas: string | null): string {
  if (!promptVentas) return basePrompt;
  return `CONTEXTO DE LA EMPRESA:\n${promptVentas}\n\nUsa este contexto para entender el negocio, los productos/servicios que se venden y las condiciones del embudo de ventas.\n\n${basePrompt}`;
}

// ─── Extracción segura de IDs desde embudo_personalizado ─────────────────────

// Etapas fijas del sistema (IDs canónicos)
const DEFAULT_CATEGORIAS = ["calificada", "no_calificada", "cerrada", "no_show", "cancelada"] as const;

function extractEmbudoIds(embudo: unknown): string[] | null {
  try {
    if (Array.isArray(embudo) && embudo.length > 0) {
      const ids = embudo
        .map((item: unknown) =>
          typeof item === "object" && item !== null && "id" in item
            ? String((item as Record<string, unknown>).id)
            : null,
        )
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      return ids.length > 0 ? ids : null;
    }
  } catch {
    console.warn("[analyzeCall] embudo_personalizado con formato inválido; usando categorías por defecto");
  }
  return null;
}

// ─── Clasificador comercial (dinámico con embudo) ────────────────────────────

const CLASSIFIER_PROMPT = `ROLE: Analyst-Pro
OBJECTIVE: Analizar rigurosamente una transcripción de videollamada de ventas para determinar su resultado comercial. Tu única salida debe ser un objeto JSON válido con los campos "categoria", "cash_collected" y "facturacion".

CATEGORÍAS DISPONIBLES (IDs exactos que debes usar):
- "cerrada": El lead aceptó la propuesta y se concretó la venta. Hay confirmación de pago.
- "calificada": El lead cumple el perfil ideal (necesidad, autoridad, presupuesto) pero no cerró en esta llamada.
- "no_calificada": El lead no cumple el perfil. No tiene necesidad, presupuesto o no es el decisor.
- "no_show": El lead no se presentó (solo si la llamada está vacía o no hay interlocutor).
- "cancelada": El lead canceló explícitamente antes de la llamada.

PROCESO DE ANÁLISIS PASO A PASO

Paso 1: Identificar al Vendedor (Closer)
El vendedor es la entidad con nombre corporativo. El otro es el cliente.

Paso 2: Determinar la "categoria" — ANÁLISIS PURO DEL TEXTO

1. ¿Ocurrió una transacción confirmada en la llamada? Busca: el cliente confirma pago, se intercambian datos de pago, menciona envío de comprobante.
   Si SÍ → categoria = "cerrada". Pasa al Paso 3.

2. ¿El lead cumple el perfil de cliente ideal? Tiene la necesidad, el presupuesto y la autoridad para comprar. Mostró interés genuino y la conversación avanzó.
   Si SÍ → categoria = "calificada". Pasa al Paso 3.

3. ¿El lead claramente no cumple el perfil? No tiene presupuesto, no tiene necesidad, no es el decisor, rechazó explícitamente.
   Si SÍ → categoria = "no_calificada". Pasa al Paso 3.

4. Si no hay conversación real (silencio, nadie contesta, error técnico) → categoria = "no_show".

Paso 3: Asignar Valores Monetarios

* SI categoria = "cerrada": "cash_collected" = monto exacto confirmado; "facturacion" = valor total del acuerdo.
* CUALQUIER OTRA categoria: "cash_collected" = "0"; "facturacion" = "0".

STRICT RULES
• Usa EXACTAMENTE los IDs listados (minúsculas, sin acentos): cerrada, calificada, no_calificada, no_show, cancelada.
• Todos los valores monetarios son strings de solo dígitos (ej: "1200", no "$1,200.00").
• REGLA DE ORO: Si categoria ≠ "cerrada", facturacion y cash_collected DEBEN ser "0".`;

function buildClassifierPrompt(embudoPersonalizado?: unknown): string {
  let prompt = CLASSIFIER_PROMPT;

  const customIds = extractEmbudoIds(embudoPersonalizado);
  if (customIds) {
    prompt += `

## EMBUDO PERSONALIZADO DEL CLIENTE

ATENCIÓN: Este cliente tiene un embudo de ventas personalizado. Los estados permitidos para "categoria" son los IDs de este JSON:

${JSON.stringify(embudoPersonalizado, null, 2)}

Tu obligación estricta es clasificar el resultado usando ÚNICAMENTE uno de los IDs de este embudo: [${customIds.join(", ")}].
NO uses los estados por defecto (calificada, no_calificada, cerrada). Usa SOLO los IDs del embudo anterior.
Si ninguno aplica claramente, elige el más cercano de los proporcionados.

IMPORTANTE: Aunque uses el embudo personalizado, SIEMPRE debes extraer cash_collected y facturacion si hubo transacción.

## REGLA DE ORO: Etapas Cerradas (es_cerrada: true)

Si el embudo personalizado tiene alguna etapa con "es_cerrada": true (además de la etapa "Cerrada" por defecto), ESAS ETAPAS TAMBIÉN SON TRANSACCIONES CONCRETADAS.
Aplica la misma regla de extracción de cash_collected y facturacion para esas etapas, igual que para "Cerrada".`;
  }

  return prompt;
}

function buildClassifierSchema(embudoPersonalizado?: unknown) {
  let categoriaEnum: string[];
  
  // Si hay embudo personalizado, usar IDs de etapas fijas
  if (Array.isArray(embudoPersonalizado) && embudoPersonalizado.length > 0) {
    const fijaIds = embudoPersonalizado
      .filter((item: unknown) =>
        typeof item === "object" && item !== null && 
        (item as Record<string, unknown>).es_fija === true
      )
      .map((item: unknown) => String((item as Record<string, unknown>).id))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    
    categoriaEnum = fijaIds.length > 0 ? fijaIds : [...DEFAULT_CATEGORIAS];
  } else {
    categoriaEnum = [...DEFAULT_CATEGORIAS];
  }

  return jsonSchema<ClassifierResult>({
    type: "object",
    properties: {
      categoria: { type: "string", enum: categoriaEnum },
      cash_collected: { type: "string" },
      facturacion: { type: "string" },
    },
    required: ["categoria", "cash_collected", "facturacion"],
    additionalProperties: false,
  });
}

// ─── Análisis IA dinámico (reemplaza forense + lead report) ──────────────────

const DEFAULT_ANALYSIS_PROMPT = `Eres un Analista Senior de Ventas. Analiza la transcripción de esta videollamada y genera un diagnóstico detallado en formato Markdown que incluya:

1. **Resumen ejecutivo**: Qué ocurrió en la llamada en 2-3 oraciones.
2. **Perfil del lead**: Situación actual, dolores, motivaciones detectadas.
3. **Desarrollo de la conversación**: Puntos clave discutidos, interés mostrado, preguntas relevantes del lead.
4. **Resultado**: ¿Se cerró? ¿Se ofertó? ¿Qué quedó pendiente?
5. **Recomendaciones para seguimiento**: Próximos pasos sugeridos.

Sé directo, preciso y sin relleno. Enfócate en información accionable para el equipo de ventas.`;

function buildAnalysisSystemPrompt(
  promptVentas: string | null,
  promptVideollamadas: string | null,
): string {
  const parts: string[] = [];

  parts.push("Estás recibiendo la transcripción de una videollamada de ventas de una empresa.");

  if (promptVentas) {
    parts.push(`\nCONTEXTO DE LA EMPRESA:\n${promptVentas}`);
  }

  if (promptVideollamadas) {
    parts.push(`\nINSTRUCCIONES ESPECÍFICAS DE EVALUACIÓN:\n${promptVideollamadas}`);
    parts.push("\nAnaliza profundamente la conversación siguiendo las instrucciones anteriores. Genera un análisis detallado y accionable en formato Markdown.");
  } else {
    parts.push(`\n${DEFAULT_ANALYSIS_PROMPT}`);
  }

  return parts.join("\n");
}

// ─── Objeciones (mejorado con contexto y ejemplos) ───────────────────────────

const OBJECTIONS_PROMPT = `Eres un analizador experto en identificar EXCLUSIVAMENTE objeciones de venta que representan barreras reales para cerrar una venta inmediatamente.

CATEGORÍAS VÁLIDAS: PRECIO, AUTORIDAD, TIEMPO, CONFIANZA, NECESIDAD, COMPARACION, CAPACIDAD, GENERAL.

DEFINICIÓN ESTRICTA: Una objeción es una declaración EXPLÍCITA del prospecto que:
- Impide cerrar la venta EN ESTE MOMENTO
- Expresa una barrera ESPECÍFICA para comprar
- Se refiere directamente a ESTA oferta específica

FILTROS CRÍTICOS — Esto NUNCA es una objeción:
- Preguntas logísticas: "¿a qué hora abren?", "¿dónde quedan?", "¿cómo llego?", "¿cuál es la dirección?"
- Coordinación de pago: "te pago a las 5", "dame los datos para pagar", "envío el comprobante"
- Preguntas informativas: "¿cuánto cuesta?", "¿qué incluye?", "¿cómo funciona?" (son consultas normales del proceso de venta, NO barreras)
- Interrupciones: "tengo que irme", "me llaman por la otra línea", "espérame un momento"
- Descripciones del negocio del prospecto: "mi audiencia no está en redes", "tenemos 10 empleados"
- Problemas operativos del prospecto: "las ventas están bajas", "no tenemos suficiente tráfico"
- Conversación trivial o saludos: "hola", "¿cómo estás?", "mucho gusto"
- Preguntas sobre el producto que NO expresan rechazo: "¿tienen arroz con pollo?", "¿qué colores hay?"

EJEMPLOS DE OBJECIONES REALES:
- PRECIO: "Es muy caro para mí", "No tengo ese presupuesto", "Encontré algo más barato"
- AUTORIDAD: "Tengo que consultarlo con mi socio/esposa/jefe", "Yo no tomo esa decisión solo"
- TIEMPO: "Ahora no es buen momento", "Quizás el próximo mes", "Necesito pensarlo"
- CONFIANZA: "No estoy seguro de que funcione", "¿Cómo sé que esto da resultados?", "He tenido malas experiencias"
- NECESIDAD: "No creo que lo necesite", "Ya tengo algo que me funciona"
- COMPARACION: "Estoy viendo otras opciones", "La competencia ofrece X"
- CAPACIDAD: "No creo que pueda implementarlo", "No tengo el equipo para eso"

ALGORITMO: Solo extrae frases del PROSPECTO que respondan a "¿Por qué NO puedes o NO quieres comprar AHORA?".

Si no encuentras objeciones válidas, devuelve {"objeciones": []}.`;

// ─── Schemas ─────────────────────────────────────────────────────────────────

const objectionsSchema = jsonSchema<{ objeciones: ObjecionItem[] }>({
  type: "object",
  properties: {
    objeciones: {
      type: "array",
      items: {
        type: "object",
        properties: {
          objecion: { type: "string" },
          categoria: { type: "string" },
        },
        required: ["objecion", "categoria"],
        additionalProperties: false,
      },
    },
  },
  required: ["objeciones"],
  additionalProperties: false,
});

// ─── Normalización post-IA: mapea name → id en embudo personalizado ──────────
// La IA a veces devuelve el `name` (ej: "Scheduled") en vez del `id` ("programado").
// Esta función hace el mapeo inverso name→id para garantizar consistencia en BD.

function normalizeClassifierResult(
  result: ClassifierResult,
  embudoPersonalizado?: unknown,
): ClassifierResult {
  if (!result?.categoria) return result;
  const customIds = extractEmbudoIds(embudoPersonalizado);
  if (!customIds) return result; // sin embudo → defaults, la IA devuelve lo correcto

  // Si la categoría ya es un ID válido, no hay nada que hacer
  if (customIds.includes(result.categoria)) return result;

  // Intentar mapear por name (case-insensitive)
  const embudoArr = Array.isArray(embudoPersonalizado) ? embudoPersonalizado : [];
  const match = embudoArr.find(
    (e: unknown) =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as Record<string, unknown>).name === "string" &&
      (e as Record<string, string>).name.toLowerCase().trim() === result.categoria.toLowerCase().trim(),
  ) as Record<string, string> | undefined;

  if (match?.id) {
    console.log(`[normalizeClassifierResult] Mapeando "${result.categoria}" → "${match.id}" (name→id)`);
    return { ...result, categoria: match.id };
  }

  // Fallback: tomar el primer ID del embudo (el más "seguimiento" suele ser el último)
  const fallbackId = customIds[customIds.length - 1] ?? customIds[0];
  console.warn(`[normalizeClassifierResult] Categoría desconocida "${result.categoria}" → fallback "${fallbackId}"`);
  return { ...result, categoria: fallbackId };
}

// ─── Análisis de texto para llamadas telefónicas (Twilio/GHL) ────────────────

const DEFAULT_LLAMADA_ANALYSIS_PROMPT = `Eres un Analista Senior de Ventas. Analiza la transcripción de esta llamada telefónica y genera un diagnóstico detallado en formato Markdown que incluya:

1. **Resumen ejecutivo**: Qué ocurrió en la llamada en 2-3 oraciones.
2. **Perfil del lead**: Situación actual, dolores, motivaciones detectadas.
3. **Desarrollo de la conversación**: Puntos clave discutidos, interés mostrado, preguntas relevantes del lead.
4. **Resultado**: Estado final de la llamada y qué quedó pendiente.
5. **Recomendaciones para seguimiento**: Próximos pasos sugeridos.

Sé directo, preciso y sin relleno. Enfócate en información accionable para el equipo de ventas.`;

export async function generateLlamadaAnalysisText(
  transcript: string,
  promptVentas: string | null,
  promptLlamadas: string | null,
  openaiApiKey?: string | null,
): Promise<string | null> {
  if (!transcript.trim()) return null;

  const model = resolveModel(openaiApiKey);

  const parts: string[] = [];
  parts.push("Estás recibiendo la transcripción de una llamada telefónica de ventas de una empresa.");

  if (promptVentas) {
    parts.push(`\nCONTEXTO DE LA EMPRESA:\n${promptVentas}`);
  }

  if (promptLlamadas) {
    parts.push(`\nINSTRUCCIONES ESPECÍFICAS DE EVALUACIÓN:\n${promptLlamadas}`);
    parts.push("\nAnaliza profundamente la conversación siguiendo las instrucciones anteriores. Genera un análisis detallado y accionable en formato Markdown.");
  } else {
    parts.push(`\n${DEFAULT_LLAMADA_ANALYSIS_PROMPT}`);
  }

  const systemPrompt = parts.join("\n");

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: `Transcript:\n${transcript}`,
      temperature: 0.3,
    });
    return result.text ?? null;
  } catch (err) {
    console.error("[generateLlamadaAnalysisText] Error generating analysis:", err);
    return null;
  }
}

// ─── Función principal: 3 llamadas IA + evaluador de reglas en paralelo ──────

export async function analyzeCall(
  formattedTranscript: string,
  promptVentas: string | null,
  promptVideollamadas: string | null,
  openaiApiKey?: string | null,
  embudoPersonalizado?: unknown,
  reglasEtiquetas?: unknown,
): Promise<CallAnalysisResult> {
  const model = resolveModel(openaiApiKey);

  const classifierSystemPrompt = withBusinessContext(
    buildClassifierPrompt(embudoPersonalizado),
    promptVentas,
  );
  const classifierSch = buildClassifierSchema(embudoPersonalizado);

  const analysisSystemPrompt = buildAnalysisSystemPrompt(promptVentas, promptVideollamadas);

  const [classifierSettled, analysisSettled, objectionsSettled, reglasSettled] =
    await Promise.allSettled([
      // 1. Clasificador comercial (dinámico con embudo)
      generateObject({
        model,
        schema: classifierSch,
        system: classifierSystemPrompt,
        prompt: `Transcript:\n${formattedTranscript}`,
        temperature: 0,
      }),

      // 2. Análisis IA (prompt_ventas + prompt_videollamadas)
      generateText({
        model,
        system: analysisSystemPrompt,
        prompt: `Transcript:\n${formattedTranscript}`,
        temperature: 0.3,
      }),

      // 3. Objeciones (mejorado con contexto y ejemplos)
      generateObject({
        model,
        schema: objectionsSchema,
        system: withBusinessContext(OBJECTIONS_PROMPT, promptVentas),
        prompt: `Transcript:\n${formattedTranscript}`,
        temperature: 0,
      }),

      // 4. Evaluador de reglas de etiquetas
      evaluateReglas(
        formattedTranscript,
        reglasEtiquetas,
        "meeting",
        promptVentas,
        openaiApiKey,
      ),
    ]);

  return {
    classifier:
      classifierSettled.status === "fulfilled"
        ? normalizeClassifierResult(classifierSettled.value.object, embudoPersonalizado)
        : null,
    analysisText:
      analysisSettled.status === "fulfilled"
        ? analysisSettled.value.text
        : null,
    objections:
      objectionsSettled.status === "fulfilled"
        ? objectionsSettled.value.object.objeciones
        : null,
    reglasResult:
      reglasSettled.status === "fulfilled"
        ? reglasSettled.value
        : { matched_tags: [], matched_rules: [] },
  };
}

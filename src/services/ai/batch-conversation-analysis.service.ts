import { generateObject, generateText, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { env } from "../../config/env.js";
import { trackApiUsage, TIPO_CONSUMO } from "./track-api-usage.service.js";

// ─── Clientes IA ──────────────────────────────────────────────────────────────

const defaultProvider = createOpenAI({ apiKey: env.OPENAI_API_KEY });
const defaultModel = defaultProvider("gpt-4o-mini");

function resolveModel(openaiApiKey?: string | null): LanguageModel {
  if (openaiApiKey) {
    return createOpenAI({ apiKey: openaiApiKey })("gpt-4o-mini");
  }
  return defaultModel;
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface ObjecionBatch {
  objecion: string;
  categoria: "precio" | "tiempo" | "confianza" | "competencia" | "necesidad" | "autoridad" | "otra";
  respuesta_vendedor: string;
  contexto: string;
}

/** Formato extendido guardado en ia_objeciones por el cron batch */
export interface IaObjecionesBatch {
  objeciones: ObjecionBatch[];
  sentimiento: "positivo" | "neutro" | "negativo";
  senales_compra: string[];
}

export interface ChatBatchAnalysisResult {
  ia_objeciones: IaObjecionesBatch;
  categoria: string | null;
}

export interface LlamadaBatchAnalysisResult {
  ia_descripcion: string;
  sentimiento: "positivo" | "neutro" | "negativo";
  objeciones: ObjecionBatch[];
  senales_compra: string[];
}

// ─── Schema para análisis batch de chats ─────────────────────────────────────

function buildChatBatchSchema(estadosEnum: string[]) {
  return jsonSchema<{
    categoria: string | null;
    objeciones: Array<{ objecion: string; categoria: string }>;
    sentimiento: "positivo" | "neutro" | "negativo";
    senales_compra: string[];
  }>({
    type: "object",
    properties: {
      categoria: {
        anyOf: [{ type: "string", enum: estadosEnum }, { type: "null" }],
        description: "Etapa del embudo de ventas del lead",
      },
      objeciones: {
        type: "array",
        description: "Objeciones de venta detectadas",
        items: {
          type: "object",
          properties: {
            objecion: { type: "string", description: "Texto literal de la objeción" },
            categoria: {
              type: "string",
              enum: ["precio", "tiempo", "confianza", "competencia", "necesidad", "autoridad", "otra"],
            },
            respuesta_vendedor: {
              type: "string",
              description: "Respuesta LITERAL (verbatim) del vendedor/asesor a esta objeción, copiada exactamente de la conversación",
            },
            contexto: {
              type: "string",
              description: "Breve contexto de la situación: qué estaban hablando cuando el lead dijo la objeción (máx 200 chars)",
            },
          },
          required: ["objecion", "categoria", "respuesta_vendedor", "contexto"],
          additionalProperties: false,
        },
      },
      sentimiento: {
        type: "string",
        enum: ["positivo", "neutro", "negativo"],
        description: "Sentimiento general del lead en la conversación",
      },
      senales_compra: {
        type: "array",
        items: { type: "string" },
        description: "Señales de intención de compra detectadas (frases clave del lead)",
      },
    },
    required: ["categoria", "objeciones", "sentimiento", "senales_compra"],
    additionalProperties: false,
  });
}

function buildChatBatchSystemPrompt(
  embudo: Array<{ id: string; nombre: string }>,
  promptEmpresa?: string,
  categoriasCustom?: Array<{ slug: string; label: string; descripcion: string }>,
  promptCalificacionChats?: string | null,
): string {
  const parts: string[] = [];

  if (promptEmpresa) {
    parts.push(`## CONTEXTO DE LA EMPRESA\n${promptEmpresa}`);
  }

  if (promptCalificacionChats) {
    parts.push(`## CRITERIOS DE CALIFICACIÓN DEL CLIENTE (CHATS)\n${promptCalificacionChats}\n\nUsa estos criterios proporcionados por el cliente para guiar tu clasificación del lead.`);
  }

  parts.push(`## TU FUNCIÓN
Analiza conversaciones de ventas y extrae métricas clave para el equipo comercial.
Responde ÚNICAMENTE con el JSON solicitado. Sin texto adicional.`);

  if (embudo.length > 0) {
    const embudoStr = embudo
      .map((e) => `- ID: "${e.id}" | Nombre: "${e.nombre}"`)
      .join("\n");
    parts.push(`## ETAPAS DEL EMBUDO (usa el ID exacto)\n${embudoStr}\n\nElige el ID que mejor describe el estado del lead. Si no puedes determinar, devuelve null.`);
  } else {
    parts.push(`## CATEGORÍAS GENERALES\nUsa: "interesado", "no_interesado", "seguimiento", "programado"`);
  }

  if (categoriasCustom && categoriasCustom.length > 0) {
    const customStr = categoriasCustom
      .map((c) => `- ID: "${c.slug}" | Nombre: "${c.label}" | Significado: ${c.descripcion}`)
      .join("\n");
    parts.push(`## CATEGORÍAS ADICIONALES DEFINIDAS POR EL CLIENTE\nAdemás de las etapas anteriores, considera estas categorías personalizadas:\n${customStr}\n\nSi el lead encaja mejor en una de estas categorías, úsala como valor de "categoria".`);
  }

  parts.push(`## OBJECIONES DE VENTA
Detecta SOLO objeciones que representen barreras REALES y DIRECTAS para cerrar la venta. Categorías:
- "precio": demasiado caro, sin presupuesto, encontré algo más barato
- "tiempo": ahora no es buen momento, quizás el próximo mes, necesito pensarlo
- "confianza": no estoy seguro de que funcione, necesito investigar, he tenido malas experiencias
- "competencia": ya tengo otra empresa, viendo otras opciones
- "necesidad": no lo necesito, ya lo tenemos internamente
- "autoridad": no soy quien decide, debo consultar con mi jefe
- "otra": cualquier otra barrera real de compra

REGLA ANTI-FALSOS POSITIVOS: Lee el contexto completo antes de marcar algo como objeción.
- Si el lead TAMBIÉN expresa interés o aceptación en el mismo segmento → NO es objeción.
- Preferencias logísticas, roleplay, simulaciones o ejemplos hipotéticos → NO son objeciones.
- Si NO puedes explicar claramente POR QUÉ esa frase impide la venta → NO la incluyas.
Si no hay objeciones reales, devuelve [].

RESPUESTA DEL VENDEDOR: Para CADA objeción, incluye la respuesta LITERAL del asesor/vendedor.
- Copia las palabras EXACTAS tal cual aparecen en la conversación — NO parafrasees ni resumas.
- Si el asesor no respondió a esa objeción, usa "" (cadena vacía).
- Máximo 300 caracteres.

CONTEXTO: Para CADA objeción, incluye "contexto" con una breve descripción (1-2 oraciones, máx 200 chars) de qué estaban hablando cuando el lead dijo la objeción.`);

  parts.push(`## SENTIMIENTO GENERAL
- "positivo": lead receptivo, interesado, con intención de avanzar
- "neutro": sin señales claras de interés ni rechazo
- "negativo": lead desinteresado, irritado o con objeciones sin resolver`);

  parts.push(`## SEÑALES DE COMPRA
Frases literales o parafraseos del lead que indiquen intención de compra:
ej. "¿cuándo podría empezar?", "¿aceptan tarjeta?", "¿me pueden mandar la propuesta?"
Si no hay señales claras, devuelve [].`);

  return parts.join("\n\n");
}

// ─── Truncar conversación (~8000 chars) ──────────────────────────────────────

const MAX_CHARS = 8000;

function truncateConversation(
  messages: Array<{ role: string; message: string; timestamp?: string; name?: string }>,
): string {
  const lines = messages.map((m) => {
    const role = m.role === "lead" ? "Lead" : m.role === "agent" ? "Asesor" : m.role;
    const name = m.name ? ` (${m.name})` : "";
    return `${role}${name}: ${m.message ?? ""}`;
  });

  let result = "";
  for (const line of lines) {
    if ((result + line).length > MAX_CHARS) {
      result += "\n... [conversación truncada]";
      break;
    }
    result += line + "\n";
  }
  return result.trim();
}

// ─── Análisis batch de chat ───────────────────────────────────────────────────

export async function analyzeChatBatch(params: {
  messages: Array<{ role: string; message: string; timestamp?: string; name?: string }>;
  embudo: Array<{ id: string; nombre: string }>;
  prompt_empresa?: string | null;
  openai_api_key?: string | null;
  id_cuenta?: number | null;
  categorias_custom?: Array<{ slug: string; label: string; descripcion: string }> | null;
  prompt_calificacion_chats?: string | null;
}): Promise<ChatBatchAnalysisResult> {
  const { messages, embudo, prompt_empresa, openai_api_key, id_cuenta, categorias_custom, prompt_calificacion_chats } = params;

  const conversationText = truncateConversation(messages);
  if (!conversationText) {
    return {
      ia_objeciones: { objeciones: [], sentimiento: "neutro", senales_compra: [] },
      categoria: null,
    };
  }

  const model = resolveModel(openai_api_key);
  const embudoIds = embudo.map((e) => e.id);
  const estadosValidos = embudoIds.length > 0
    ? embudoIds
    : ["interesado", "no_interesado", "seguimiento", "programado"];

  const customSlugs = (categorias_custom ?? []).map((c) => c.slug);
  const allEstados = [...estadosValidos, ...customSlugs.filter((s) => !estadosValidos.includes(s))];

  const schema = buildChatBatchSchema(allEstados);
  const systemPrompt = buildChatBatchSystemPrompt(embudo, prompt_empresa ?? undefined, categorias_custom ?? undefined, prompt_calificacion_chats);

  const { object, usage } = await generateObject({
    model,
    schema,
    system: systemPrompt,
    prompt: `Analiza esta conversación de chat de ventas:\n\n${conversationText}`,
    temperature: 0,
  });

  void trackApiUsage(id_cuenta, TIPO_CONSUMO.GPT4O_MINI, usage.totalTokens ?? 0);

  return {
    ia_objeciones: {
      objeciones: Array.isArray(object.objeciones) ? (object.objeciones as ObjecionBatch[]) : [],
      sentimiento: object.sentimiento ?? "neutro",
      senales_compra: Array.isArray(object.senales_compra) ? object.senales_compra : [],
    },
    categoria: object.categoria ?? null,
  };
}

// ─── Schema para análisis batch de llamadas ───────────────────────────────────

const llamadaBatchSchema = jsonSchema<{
  resumen: string;
  sentimiento: "positivo" | "neutro" | "negativo";
  objeciones: Array<{ objecion: string; categoria: string; respuesta_vendedor: string; contexto: string }>;
  senales_compra: string[];
}>({
  type: "object",
  properties: {
    resumen: {
      type: "string",
      description: "Resumen ejecutivo de la llamada en 2-3 oraciones",
    },
    sentimiento: {
      type: "string",
      enum: ["positivo", "neutro", "negativo"],
      description: "Sentimiento general del lead",
    },
    objeciones: {
      type: "array",
      items: {
        type: "object",
        properties: {
          objecion: { type: "string" },
          categoria: {
            type: "string",
            enum: ["precio", "tiempo", "confianza", "competencia", "necesidad", "autoridad", "otra"],
          },
          respuesta_vendedor: {
            type: "string",
            description: "Respuesta LITERAL (verbatim) del vendedor a esta objeción, copiada exactamente de la transcripción",
          },
          contexto: {
            type: "string",
            description: "Breve contexto de la situación: qué estaban hablando cuando el prospecto dijo la objeción (máx 200 chars)",
          },
        },
        required: ["objecion", "categoria", "respuesta_vendedor", "contexto"],
        additionalProperties: false,
      },
    },
    senales_compra: {
      type: "array",
      items: { type: "string" },
      description: "Señales de intención de compra detectadas",
    },
  },
  required: ["resumen", "sentimiento", "objeciones", "senales_compra"],
  additionalProperties: false,
});

const LLAMADA_BATCH_SYSTEM = `Eres un Analista de Ventas. Analiza transcripciones de llamadas telefónicas de ventas.
Extrae métricas clave para el equipo comercial.
Responde ÚNICAMENTE con el JSON solicitado. Sin texto adicional.

OBJECIONES — Solo barreras REALES y DIRECTAS para cerrar la venta:
- "precio": demasiado caro, sin presupuesto, encontré algo más barato
- "tiempo": ahora no es buen momento, quizás el próximo mes, necesito pensarlo
- "confianza": no estoy seguro de que funcione, necesito investigar, malas experiencias
- "competencia": otras opciones, otra empresa
- "necesidad": no lo necesito, ya lo tenemos
- "autoridad": no decido solo, debo consultar con mi jefe
- "otra": otra barrera real de compra

REGLA ANTI-FALSOS POSITIVOS: Lee el contexto completo antes de marcar algo como objeción.
- Si el prospecto TAMBIÉN expresa interés en el mismo segmento → NO es objeción.
- Preferencias logísticas, roleplay, simulaciones → NO son objeciones.
- Si NO puedes explicar POR QUÉ esa frase impide la venta → NO la incluyas.
Si no hay objeciones reales, devuelve [].

RESPUESTA DEL VENDEDOR: Para CADA objeción, incluye "respuesta_vendedor" con las palabras EXACTAS que el vendedor dijo al responder esa objeción. NO parafrasees — copia VERBATIM de la transcripción. Si no respondió, usa "". Máximo 300 chars.

CONTEXTO: Para CADA objeción, incluye "contexto" con una breve descripción (1-2 oraciones, máx 200 chars) de qué estaban hablando cuando el prospecto dijo la objeción.

SENTIMIENTO: positivo (receptivo/interesado) | neutro (sin señales claras) | negativo (desinteresado/irritado)

SEÑALES DE COMPRA: frases del lead que indiquen intención de avanzar.
Si no hay señales, devuelve [].`;

// ─── Análisis batch de llamada ────────────────────────────────────────────────

export async function analyzeLlamadaBatch(params: {
  transcripcion: string;
  prompt_ventas?: string | null;
  prompt_llamadas?: string | null;
  openai_api_key?: string | null;
  id_cuenta?: number | null;
}): Promise<LlamadaBatchAnalysisResult | null> {
  const { transcripcion, prompt_ventas, prompt_llamadas, openai_api_key, id_cuenta } = params;

  if (!transcripcion.trim()) return null;

  const model = resolveModel(openai_api_key);

  // Build system prompt with optional company context
  const systemParts: string[] = [];
  if (prompt_ventas) {
    systemParts.push(`CONTEXTO DE LA EMPRESA:\n${prompt_ventas}`);
  }
  if (prompt_llamadas) {
    systemParts.push(`INSTRUCCIONES DE EVALUACIÓN:\n${prompt_llamadas}`);
  }
  systemParts.push(LLAMADA_BATCH_SYSTEM);
  const systemPrompt = systemParts.join("\n\n");

  const transcriptTruncated = transcripcion.slice(0, 8000);

  // Run structured extraction and text analysis in parallel
  const [structuredResult, textResult] = await Promise.allSettled([
    generateObject({
      model,
      schema: llamadaBatchSchema,
      system: systemPrompt,
      prompt: `Transcripción de llamada:\n${transcriptTruncated}`,
      temperature: 0,
    }),
    generateText({
      model,
      system: [
        prompt_ventas ? `CONTEXTO DE LA EMPRESA:\n${prompt_ventas}` : null,
        prompt_llamadas ?? `Eres un Analista Senior de Ventas. Analiza la transcripción de esta llamada telefónica y genera un diagnóstico en Markdown con: 1) Resumen ejecutivo, 2) Perfil del lead, 3) Resultado y 4) Próximos pasos. Sé directo y conciso.`,
      ].filter(Boolean).join("\n\n"),
      prompt: `Transcripción:\n${transcriptTruncated}`,
      temperature: 0.3,
    }),
  ]);

  let totalTokens = 0;
  if (structuredResult.status === "fulfilled") totalTokens += structuredResult.value.usage.totalTokens ?? 0;
  if (textResult.status === "fulfilled") totalTokens += textResult.value.usage.totalTokens ?? 0;
  void trackApiUsage(id_cuenta, TIPO_CONSUMO.GPT4O_MINI, totalTokens);

  if (structuredResult.status === "rejected" && textResult.status === "rejected") {
    console.error("[analyzeLlamadaBatch] Ambas llamadas fallaron:", structuredResult.reason);
    return null;
  }

  const structured = structuredResult.status === "fulfilled" ? structuredResult.value.object : null;
  const analysisText = textResult.status === "fulfilled" ? textResult.value.text : null;

  return {
    ia_descripcion: analysisText ?? structured?.resumen ?? "Análisis no disponible",
    sentimiento: structured?.sentimiento ?? "neutro",
    objeciones: Array.isArray(structured?.objeciones) ? (structured.objeciones as ObjecionBatch[]) : [],
    senales_compra: Array.isArray(structured?.senales_compra) ? structured.senales_compra : [],
  };
}

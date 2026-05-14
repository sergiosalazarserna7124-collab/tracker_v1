import { generateObject, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { env } from "../../config/env.js";
import { trackApiUsage, TIPO_CONSUMO } from "./track-api-usage.service.js";

// ─── Clientes IA (singleton global — fallback) ──────────────────────────────

const defaultProvider = createOpenAI({ apiKey: env.OPENAI_API_KEY });
const defaultModel = defaultProvider("gpt-4o-mini");

function resolveModel(openaiApiKey?: string | null): LanguageModel {
  if (openaiApiKey) {
    return createOpenAI({ apiKey: openaiApiKey })("gpt-4o-mini");
  }
  return defaultModel;
}

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: string;
  message: string;
  timestamp: string;
  name?: string;
}

export interface EmbudoEtapa {
  id: string;
  nombre: string;
  condition?: string;
}

export interface ReglaEtiqueta {
  id: string;
  tag: string;
  condition: string;
  source: string;
}

export interface ChatAnalysisResult {
  categoria: string | null;
  tags_internos: string[];
  confianza: number;
}

// ─── Limitar tokens de la conversación (~2000 tokens ≈ 8000 chars) ──────────

const MAX_CONVERSATION_CHARS = 8000;

function truncateConversation(messages: ChatMessage[]): string {
  const lines = messages.map((m) => {
    const role = m.role === "lead" ? "Lead" : m.role === "agent" ? "Asesor" : m.role;
    const name = m.name ? ` (${m.name})` : "";
    const ts = m.timestamp ? ` [${m.timestamp}]` : "";
    return `${role}${name}${ts}: ${m.message ?? ""}`;
  });

  let result = "";
  for (const line of lines) {
    if ((result + line).length > MAX_CONVERSATION_CHARS) {
      result += "\n... [conversación truncada por longitud]";
      break;
    }
    result += line + "\n";
  }
  return result.trim();
}

// ─── Schema de salida ────────────────────────────────────────────────────────

function buildChatClassificationSchema(estadosEnum: string[]) {
  return jsonSchema<{ categoria: string | null; tags: string[]; confianza: number }>({
    type: "object",
    properties: {
      categoria: {
        anyOf: [
          { type: "string", enum: estadosEnum },
          { type: "null" },
        ],
        description: "Etapa del embudo a la que pertenece este lead",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Etiquetas internas detectadas en la conversación",
      },
      confianza: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Nivel de confianza en la clasificación (0-1)",
      },
    },
    required: ["categoria", "tags", "confianza"],
    additionalProperties: false,
  });
}

// ─── Prompt del sistema ──────────────────────────────────────────────────────

function buildSystemPrompt(
  embudo: EmbudoEtapa[],
  reglas_etiquetas: ReglaEtiqueta[],
  prompt_empresa?: string,
): string {
  const parts: string[] = [];

  if (prompt_empresa) {
    parts.push(`## CONTEXTO DE LA EMPRESA\n${prompt_empresa}\n\nUsa este contexto para entender el negocio y sus productos/servicios al momento de clasificar los leads.`);
  }

  parts.push(`## TU FUNCIÓN
Eres un sistema especializado en clasificar conversaciones de chat de ventas. Debes analizar la conversación y determinar:
1. En qué etapa del embudo de ventas se encuentra el lead
2. Qué etiquetas internas aplican según las reglas definidas
3. Tu nivel de confianza en la clasificación

Responde ÚNICAMENTE con el JSON solicitado. Sin explicaciones adicionales.`);

  if (embudo.length > 0) {
    const embudoStr = embudo
      .map((e) => `- ID: "${e.id}" | Nombre: "${e.nombre}"${e.condition ? ` | Condición: ${e.condition}` : ""}`)
      .join("\n");
    parts.push(`## ETAPAS DEL EMBUDO (usa el ID exacto en el campo "categoria")
${embudoStr}

Elige el ID de la etapa que mejor describe el estado del lead según la conversación. Si ninguna aplica claramente, elige la más cercana. Si no puedes determinar, devuelve null.`);
  } else {
    parts.push(`## CLASIFICACIÓN GENERAL
Como no hay embudo personalizado, usa estas categorías generales: "interesado", "no_interesado", "seguimiento", "programado".`);
  }

  if (reglas_etiquetas.length > 0) {
    const reglasStr = reglas_etiquetas
      .filter((r) => !r.source || r.source === "chats" || r.source === "todos")
      .map((r) => `- Tag: "${r.tag}" | Condición: ${r.condition}`)
      .join("\n");

    if (reglasStr) {
      parts.push(`## REGLAS DE ETIQUETAS INTERNAS
Aplica estas etiquetas si la conversación cumple las condiciones:
${reglasStr}

Devuelve solo los tags que EFECTIVAMENTE aplican. Si ninguno aplica, devuelve [].`);
    }
  }

  parts.push(`## FORMATO DE RESPUESTA
Devuelve ÚNICAMENTE este JSON (sin markdown, sin texto adicional):
{
  "categoria": "id_etapa_o_null",
  "tags": ["tag1", "tag2"],
  "confianza": 0.85
}`);

  return parts.join("\n\n");
}

// ─── Función principal ────────────────────────────────────────────────────────

export async function analyzeChatWithAI(params: {
  messages: ChatMessage[];
  embudo: EmbudoEtapa[];
  reglas_etiquetas: ReglaEtiqueta[];
  prompt_empresa?: string;
  openai_api_key?: string;
  id_cuenta?: number | null;
}): Promise<ChatAnalysisResult> {
  const { messages, embudo, reglas_etiquetas, prompt_empresa, openai_api_key, id_cuenta } = params;

  const model = resolveModel(openai_api_key);
  const embudoIds = embudo.map((e) => e.id);
  const fallbackIds = ["interesado", "no_interesado", "seguimiento", "programado"];
  const estadosValidos = embudoIds.length > 0 ? embudoIds : fallbackIds;

  const schema = buildChatClassificationSchema(estadosValidos);
  const systemPrompt = buildSystemPrompt(embudo, reglas_etiquetas, prompt_empresa);
  const conversationText = truncateConversation(messages);

  if (!conversationText) {
    return { categoria: null, tags_internos: [], confianza: 0 };
  }

  const { object, usage } = await generateObject({
    model,
    schema,
    system: systemPrompt,
    prompt: `Analiza la siguiente conversación de chat y clasifica el lead:\n\n${conversationText}`,
    temperature: 0,
  });

  void trackApiUsage(id_cuenta, TIPO_CONSUMO.GPT4O_MINI, usage.totalTokens ?? 0);

  return {
    categoria: object.categoria ?? null,
    tags_internos: Array.isArray(object.tags) ? object.tags : [],
    confianza: typeof object.confianza === "number" ? object.confianza : 0,
  };
}

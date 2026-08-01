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
  source?: string;
  fuentes?: string[];
}

export interface ObjecionDetectada {
  objecion: string;
  categoria: string;
  respuesta_vendedor: string;
  contexto: string;
}

export interface ChatAnalysisResult {
  categoria: string | null;
  tags_internos: string[];
  confianza: number;
  objeciones: ObjecionDetectada[];
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
  return jsonSchema<{ categoria: string | null; tags: string[]; confianza: number; objeciones: Array<{ objecion: string; categoria: string }> }>({
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
      objeciones: {
        type: "array",
        description: "Objeciones de venta detectadas en la conversación",
        items: {
          type: "object",
          properties: {
            objecion: {
              type: "string",
              description: "Texto literal o parafraseo de la objeción planteada por el lead",
            },
            categoria: {
              type: "string",
              enum: ["precio", "tiempo", "confianza", "competencia", "necesidad", "autoridad", "otra"],
              description: "Categoría de la objeción",
            },
            respuesta_vendedor: {
              type: "string",
              description: "Respuesta LITERAL (verbatim) del asesor a esta objeción, copiada exactamente de la conversación",
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
    },
    required: ["categoria", "tags", "confianza", "objeciones"],
    additionalProperties: false,
  });
}

// ─── Prompt del sistema ──────────────────────────────────────────────────────

function buildSystemPrompt(
  embudo: EmbudoEtapa[],
  reglas_etiquetas: ReglaEtiqueta[],
  prompt_empresa?: string,
  canales_activos?: string[] | null,
  prompt_calificacion_chats?: string | null,
): string {
  const parts: string[] = [];

  if (prompt_empresa) {
    parts.push(`## CONTEXTO DE LA EMPRESA\n${prompt_empresa}\n\nUsa este contexto para entender el negocio y sus productos/servicios al momento de clasificar los leads.`);
  }

  if (prompt_calificacion_chats) {
    parts.push(`## CRITERIOS DE CALIFICACIÓN DEL CLIENTE (CHATS)\n${prompt_calificacion_chats}\n\nUsa estos criterios proporcionados por el cliente para guiar tu clasificación del lead.`);
  }

  parts.push(`## TU FUNCIÓN
Eres un sistema especializado en clasificar conversaciones de chat de ventas. Debes analizar la conversación y determinar:
1. En qué etapa del embudo de ventas se encuentra el lead
2. Qué etiquetas internas aplican según las reglas definidas
3. Tu nivel de confianza en la clasificación
4. Qué objeciones de venta expresó el lead (precio, tiempo, confianza, competencia, necesidad, autoridad u otra)

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
      .filter((r) => {
        if (r.fuentes && r.fuentes.length > 0) {
          return r.fuentes.includes("todas") || r.fuentes.includes("chat") || r.fuentes.includes("chats");
        }
        return !r.source || r.source === "chats" || r.source === "todos" || r.source === "todas";
      })
      .map((r) => `- Tag: "${r.tag}" | Condición: ${r.condition}`)
      .join("\n");

    if (reglasStr) {
      parts.push(`## REGLAS DE ETIQUETAS INTERNAS
Aplica estas etiquetas si la conversación cumple las condiciones:
${reglasStr}

Devuelve solo los tags que EFECTIVAMENTE aplican. Si ninguno aplica, devuelve [].`);
    }
  }

  parts.push(`## OBJECIONES DE VENTA
Detecta SOLO objeciones que representen barreras REALES y DIRECTAS para cerrar la venta. Usa estas categorías:
- "precio": "es muy caro", "no tengo presupuesto", "encontré algo más barato"
- "tiempo": "ahora no es buen momento", "quizás el próximo mes", "necesito pensarlo"
- "confianza": "no estoy seguro de que funcione", "necesito investigar más", "he tenido malas experiencias"
- "competencia": "ya lo tengo con otra empresa", "estoy viendo otras opciones"
- "necesidad": "no lo necesito ahora", "ya lo hacemos internamente"
- "autoridad": "no soy quien decide", "tengo que consultarlo con mi jefe"
- "otra": cualquier otra barrera real de compra

REGLA ANTI-FALSOS POSITIVOS: Antes de marcar algo como objeción, lee el contexto completo.
- Si el lead TAMBIÉN expresa interés o aceptación en el mismo segmento → NO es objeción.
- Si la frase es una preferencia logística ("prefiero ir allá", "mejor en la mañana") → NO es objeción.
- Si la frase fue dicha en roleplay, simulación o ejemplo hipotético → NO es objeción.
- Si NO puedes explicar claramente POR QUÉ esa frase impide la venta → NO la incluyas.
Si no hay objeciones reales, devuelve [].

RESPUESTA DEL VENDEDOR: Para CADA objeción, incluye "respuesta_vendedor" con las palabras EXACTAS que el asesor/vendedor dijo al responder esa objeción. NO parafrasees — copia VERBATIM de la conversación. Busca en los siguientes 2-3 mensajes del asesor después de la objeción — a veces reconoce primero y responde después. Incluye CUALQUIER intento de respuesta: argumentos, reencuadres, preguntas para manejar la objeción, o propuestas alternativas. Solo usa "" si la conversación terminó inmediatamente o el asesor ignoró la objeción completamente. Máximo 300 caracteres.

CONTEXTO: Para CADA objeción, incluye "contexto" con una breve descripción (1-2 oraciones, máx 200 chars) de qué estaban hablando cuando el lead dijo la objeción. Ejemplo: "El asesor presentó el precio mensual y el lead respondió con esta objeción."`);

  if (canales_activos && canales_activos.length > 0) {
    parts.push(`## CANALES ACTIVOS DEL CLIENTE
Este cliente tiene activos los siguientes canales de comunicación: ${canales_activos.join(", ")}.
Limita tus referencias y sugerencias a estos canales únicamente. No menciones canales que el cliente no utiliza.`);
  }

  parts.push(`## FORMATO DE RESPUESTA
Devuelve ÚNICAMENTE este JSON (sin markdown, sin texto adicional):
{
  "categoria": "id_etapa_o_null",
  "tags": ["tag1", "tag2"],
  "confianza": 0.85,
  "objeciones": [{"objecion": "texto de la objeción", "categoria": "precio", "respuesta_vendedor": "palabras exactas del asesor aquí", "contexto": "El asesor presentó el precio y el lead respondió con esta objeción"}]
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
  canales_activos?: string[] | null;
  prompt_calificacion_chats?: string | null;
}): Promise<ChatAnalysisResult> {
  const { messages, embudo, reglas_etiquetas, prompt_empresa, openai_api_key, id_cuenta, canales_activos, prompt_calificacion_chats } = params;

  const model = resolveModel(openai_api_key);
  const embudoIds = embudo.map((e) => e.id);
  const fallbackIds = ["interesado", "no_interesado", "seguimiento", "programado"];
  const estadosValidos = embudoIds.length > 0 ? embudoIds : fallbackIds;

  const schema = buildChatClassificationSchema(estadosValidos);
  const systemPrompt = buildSystemPrompt(embudo, reglas_etiquetas, prompt_empresa, canales_activos, prompt_calificacion_chats);
  const conversationText = truncateConversation(messages);

  if (!conversationText) {
    return { categoria: null, tags_internos: [], confianza: 0, objeciones: [] };
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
    objeciones: Array.isArray(object.objeciones)
      ? object.objeciones.filter(
          (o): o is ObjecionDetectada =>
            typeof o === "object" && o !== null &&
            typeof (o as ObjecionDetectada).objecion === "string" &&
            typeof (o as ObjecionDetectada).categoria === "string",
        )
      : [],
  };
}

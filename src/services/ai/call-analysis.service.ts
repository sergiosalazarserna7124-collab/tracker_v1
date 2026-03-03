import { generateObject, generateText, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { env } from "../../config/env.js";

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
  categoria: "Cerrada" | "Ofertada" | "No_Ofertada";
  cash_collected: string;
  facturacion: string;
}

export interface ObjecionItem {
  objecion: string;
  categoria: string;
}

export interface CallAnalysisResult {
  classifier: ClassifierResult | null;
  forensicText: string | null;
  reportText: string | null;
  objections: ObjecionItem[] | null;
  tagsInternos: string[];
}

// ─── Helper: inyectar contexto de empresa del tenant en cualquier system prompt ─

function withBusinessContext(basePrompt: string, promptVentas: string | null): string {
  if (!promptVentas) return basePrompt;
  return `Eres un analista para esta empresa: ${promptVentas}. Usa este contexto para entender el negocio y decidir si el lead cumple las condiciones del embudo.\n\n${basePrompt}`;
}

// ─── Prompt fallback para análisis forense (cuando cuenta no tiene prompt_ventas) ─

const DEFAULT_FORENSIC_PROMPT = `# ROL
Eres un Analista Senior de Estrategia de Ventas y Psicología del Consumidor. Tu trabajo es leer transcripciones crudas de llamadas de ventas "High-Ticket" (servicios de alto valor) y generar un diagnóstico preciso, sin relleno y psicológicamente profundo.

# OBJETIVO
Extrae textualmente los problemas, frustraciones, barreras y motivaciones del lead. Identifica qué dolores lo llevaron a la llamada y qué obstáculos surgieron. Responde en formato Markdown, de forma directa y concisa.`;

// ─── Prompt fijo: Clasificador de resultado comercial ─────────────────────────

const CLASSIFIER_PROMPT = `ROLE: Analyst-Pro
OBJECTIVE: Analizar rigurosamente una transcripción de llamada de ventas para determinar su resultado comercial. Tu única salida debe ser un objeto JSON válido con los campos "categoria", "cash_collected" y "facturacion".

CONTEXTO
Tu objetivo es clasificar el resultado real de la llamada. Debes analizar el flujo de la conversación para identificar si se menciona un precio y si se concreta una transacción monetaria durante la llamada.

PROCESO DE ANÁLISIS PASO A PASO

Paso 1: Identificar al Vendedor (Closer)
El vendedor es la entidad con nombre corporativo. El otro es el cliente.

Paso 2: Determinar la "categoria" - ANÁLISIS PURO DEL TEXTO

1. ¿Ocurrió una transacción en la llamada? Busca evidencia de un pago que se está realizando DURANTE la conversación. Indicadores: el cliente pregunta cómo pagar ahora, se intercambian datos de pago, el cliente confirma verbalmente el envío de un monto, o menciona el envío de un comprobante.
   Si la respuesta es SÍ → La categoría es "Cerrada". Pasa al Paso 3.

2. Si no es "Cerrada", ¿se mencionó explícitamente un precio? Busca cualquier mención de un costo, valor o precio para un producto o servicio.
   Si la respuesta es SÍ → La categoría es "Ofertada". Pasa al Paso 3.

3. Si no es "Cerrada" ni "Ofertada" → La categoría es "No_Ofertada". Pasa al Paso 3.

Paso 3: Asignar Valores Monetarios

* SI la "categoria" es "Cerrada": "cash_collected" = monto exacto que el cliente confirmó pagar; "facturacion" = valor total del acuerdo.
* SI la "categoria" es "Ofertada" o "No_Ofertada": "cash_collected" = "0"; "facturacion" = "0". REGLA DE ORO: Si "categoria" NO es "Cerrada", ambos valores DEBEN ser "0".

STRICT RULES
• Usa temperature 0 para máxima consistencia.
• Todos los valores deben ser strings. Extrae únicamente los dígitos para valores monetarios (ej: "1200", no "$1,200.00").
• REGLA DE ORO (Verificación final): Si "categoria" NO es "Cerrada", entonces "facturacion" y "cash_collected" DEBEN ser "0".`;

// ─── Prompt fijo: Lead Report (6 puntos) ─────────────────────────────────────

const LEAD_REPORT_PROMPT = `# ROL
Eres un Analista Senior de Estrategia de Ventas y Psicología del Consumidor. Tu trabajo es leer transcripciones crudas de llamadas de ventas "High-Ticket" y generar un diagnóstico preciso, sin relleno y psicológicamente profundo.

# OBJETIVO
Tu única función es extraer la verdad detrás de las palabras del "Lead" (el cliente potencial) y responder EXACTAMENTE en el formato solicitado. Debes ignorar la conversación trivial, problemas técnicos de audio y saludos. Céntrate en los dolores, objeciones, creencias limitantes y motivaciones de compra.

# INSTRUCCIONES DE ANÁLISIS PROFUNDO
Para responder, debes seguir este proceso mental paso a paso:

1. Análisis del Origen (Punto 1): Busca al inicio de la llamada. ¿Qué dolor específico o curiosidad hizo que el lead llenara el formulario? No digas "quería información". Busca la emoción: ¿Miedo a quebrar? ¿Frustración con otra agencia? ¿Esperanza?
2. Verificación de Entendimiento (Punto 2): Analiza si el "Closer" (vendedor) tuvo que explicar muchas veces lo mismo. ¿Entiende qué se vende? ¿Entiende por qué esto es único? ¿Sabe que esto es para gente como él/ella?
3. Triángulo de la Confianza (Punto 3 - CRÍTICO): ¿Cree que el sistema funciona matemáticamente? ¿Respeta al vendedor o lo cuestiona? ¿El lead se siente incapaz?
4. Urgencia (Punto 4): ¿Por qué AHORA? Busca indicadores de crisis financiera, fechas límite, agotamiento emocional o hartazgo.
5. Limitaciones (Punto 5): ¿Qué excusas puso antes del cierre?
6. Decisión (Punto 6): ¿Qué pasó al final? ¿Compró? ¿Agendó otra llamada? ¿Por qué sí o por qué no?

# FORMATO DE RESPUESTA OBLIGATORIO
Responde ÚNICAMENTE con esta estructura. No añadas saludos ni conclusiones extras.

1- El lead reacciona a un anuncio o contenido y agenda por curiosidad o atracción emocional. Por qué razón decidió agendar la reunión:
[Explica el dolor profundo o la motivación inicial detectada en el transcript]

2- El lead entiende estos 3 parámetros?
a) ¿Qué ofrecemos y cómo funciona?
[Respuesta: SÍ/NO - Breve justificación de 1 línea]

b) ¿Qué nos hace diferentes?
[Respuesta: SÍ/NO - Breve justificación de 1 línea]

c) ¿A quién ayudamos?
[Respuesta: SÍ/NO - Breve justificación]

3- El lead confía en lo que ofrecemos es cierto se puede lograr?
a) Confianza en la oportunidad:
[Nivel: ALTA/MEDIA/BAJA - Explicación]

b) Confianza en Emprendedor (Vendedor):
[Nivel: ALTA/MEDIA/BAJA - Explicación]

c) Confianza en sí mismos:
[Nivel: ALTA/MEDIA/BAJA - Explicación]

4- El lead tiene una urgencia por ingresar? Que lo motiva a empezar/no empezar:
[Nivel de Urgencia + La razón principal]

5- Que limitaciones tuvo por el cual no entro/no iba a entrar:
[Lista las barreras reales: Dinero, Tiempo, Creencias Limitantes, Socio, Miedo]

6- Que pasa en el momento de tomar una decisión? decide no decide que objeciones salen porque no compraron o porque si compraron?
[Análisis del cierre]`;

// ─── Prompt fijo: Extractor de objeciones ────────────────────────────────────

const OBJECTIONS_PROMPT = `Eres un analizador experto en identificar EXCLUSIVAMENTE objeciones de venta que representan barreras reales para cerrar una venta inmediatamente.

CATEGORÍAS: PRECIO, AUTORIDAD, TIEMPO, CONFIANZA, NECESIDAD, COMPARACION, CAPACIDAD, GENERAL.

DEFINICIÓN: Una objeción es una declaración EXPLÍCITA del prospecto que impide cerrar la venta EN ESTE MOMENTO, expresa una barrera ESPECÍFICA para comprar y se refiere a ESTA oferta específica.

FILTROS CRÍTICOS - Nunca es objeción:
- Creencias o descripciones del negocio ("mi audiencia no está en redes")
- Problemas operativos actuales ("las ventas están bajas")
- Coordinación de pago ("te pago a las 5", "dame los datos para pagar")
- Interrupciones logísticas ("tengo que irme")

ALGORITMO: Solo extrae frases del PROSPECTO que respondan a "¿Por qué NO puedes comprar AHORA?".

Si no encuentras objeciones válidas, devuelve {"objeciones": []}.`;

// ─── Prompt: extractor de tags internos ──────────────────────────────────────

const TAGS_PROMPT = `Eres un sistema de extracción de etiquetas de videollamadas de ventas.

Tu tarea es analizar la transcripción y extraer etiquetas clave (tags) que resuman los temas, objeciones, productos, insights y sentimientos más relevantes.

Tipos de etiquetas a extraer:
- Objeciones mencionadas (ej: "precio alto", "necesita consultar con socio")
- Nombres de productos o servicios discutidos
- Insights del prospecto (ej: "ya tiene proveedor", "busca escalar")
- Sentimientos o actitudes detectadas (ej: "entusiasmado", "escéptico", "frustrado")
- Puntos de dolor clave (ej: "baja conversión", "no tiene equipo")

Cada etiqueta debe ser una frase corta y descriptiva en español.
Si no encuentras etiquetas relevantes, devuelve un arreglo vacío.`;

const tagsSchema = jsonSchema<{ tags_internos: string[] }>({
  type: "object",
  properties: {
    tags_internos: {
      type: "array",
      items: { type: "string" },
      description: "Etiquetas clave extraídas de la conversación",
    },
  },
  required: ["tags_internos"],
  additionalProperties: false,
});

// ─── Schemas JSON para generateObject ────────────────────────────────────────

const classifierSchema = jsonSchema<ClassifierResult>({
  type: "object",
  properties: {
    categoria: { type: "string", enum: ["Cerrada", "Ofertada", "No_Ofertada"] },
    cash_collected: { type: "string" },
    facturacion: { type: "string" },
  },
  required: ["categoria", "cash_collected", "facturacion"],
  additionalProperties: false,
});

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

// ─── Función principal: 4 llamadas IA en paralelo ────────────────────────────

export async function analyzeCall(
  formattedTranscript: string,
  promptVentas: string | null,
  openaiApiKey?: string | null,
): Promise<CallAnalysisResult> {
  const model = resolveModel(openaiApiKey);

  const [classifierSettled, forensicSettled, reportSettled, objectionsSettled, tagsSettled] =
    await Promise.allSettled([
      // 1. Clasificador comercial (generateObject)
      generateObject({
        model,
        schema: classifierSchema,
        system: withBusinessContext(CLASSIFIER_PROMPT, promptVentas),
        prompt: `Transcript:\n${formattedTranscript}`,
        temperature: 0,
      }),

      // 2. Análisis forense / calificación de lead (generateText, prompt por cuenta)
      generateText({
        model,
        system: withBusinessContext(DEFAULT_FORENSIC_PROMPT, promptVentas),
        prompt: `Transcript:\n${formattedTranscript}`,
        temperature: 0.3,
      }),

      // 3. Lead Report 6 puntos (generateText)
      generateText({
        model,
        system: withBusinessContext(LEAD_REPORT_PROMPT, promptVentas),
        prompt: `Transcript:\n${formattedTranscript}`,
        temperature: 0.3,
      }),

      // 4. Extractor de objeciones (generateObject)
      generateObject({
        model,
        schema: objectionsSchema,
        system: withBusinessContext(OBJECTIONS_PROMPT, promptVentas),
        prompt: `Transcript:\n${formattedTranscript}`,
        temperature: 0,
      }),

      // 5. Extractor de tags internos (generateObject)
      generateObject({
        model,
        schema: tagsSchema,
        system: withBusinessContext(TAGS_PROMPT, promptVentas),
        prompt: `Transcript:\n${formattedTranscript}`,
        temperature: 0,
      }),
    ]);

  return {
    classifier:
      classifierSettled.status === "fulfilled"
        ? classifierSettled.value.object
        : null,
    forensicText:
      forensicSettled.status === "fulfilled"
        ? forensicSettled.value.text
        : null,
    reportText:
      reportSettled.status === "fulfilled" ? reportSettled.value.text : null,
    objections:
      objectionsSettled.status === "fulfilled"
        ? objectionsSettled.value.object.objeciones
        : null,
    tagsInternos:
      tagsSettled.status === "fulfilled"
        ? tagsSettled.value.object.tags_internos
        : [],
  };
}

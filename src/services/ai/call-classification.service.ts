import OpenAI, { toFile } from "openai";
import { generateObject, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { env } from "../../config/env.js";
import { GHL_TAGS } from "../ghl-api.service.js";
import { trackApiUsage, TIPO_CONSUMO } from "./track-api-usage.service.js";

// ─── Clientes IA (singletons globales — fallback) ────────────────────────────

const defaultWhisperClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const defaultAiProvider = createOpenAI({ apiKey: env.OPENAI_API_KEY });
const defaultModel = defaultAiProvider("gpt-4o-mini");

// ─── Factory: resolver clientes por tenant o fallback global ─────────────────

function resolveClients(openaiApiKey?: string | null): {
  whisper: OpenAI;
  model: LanguageModel;
} {
  if (openaiApiKey) {
    const tenantWhisper = new OpenAI({ apiKey: openaiApiKey });
    const tenantProvider = createOpenAI({ apiKey: openaiApiKey });
    return { whisper: tenantWhisper, model: tenantProvider("gpt-4o-mini") };
  }
  return { whisper: defaultWhisperClient, model: defaultModel };
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CallClassification {
  buzon: boolean | null;
  estado: string | null;
  iadesc: string | null;
  tags_internos: string[];
}

// ─── Whisper: transcribir audio ──────────────────────────────────────────────

export async function transcribeAudio(
  audioBuffer: Buffer,
  openaiApiKey?: string | null,
  idCuenta?: number | null,
): Promise<string> {
  const { whisper } = resolveClients(openaiApiKey);
  const file = await toFile(audioBuffer, "recording.mp3", { type: "audio/mpeg" });

  const transcription = await whisper.audio.transcriptions.create({
    file,
    model: "whisper-1",
  });

  void trackApiUsage(idCuenta, TIPO_CONSUMO.WHISPER, 1);

  return transcription.text;
}

// ─── Clasificar llamada con IA ───────────────────────────────────────────────

const CLASSIFIER_PROMPT = `Eres un sistema de clasificación de llamadas telefónicas altamente especializado. Tu ÚNICA función es analizar transcripciones de llamadas y devolver un JSON estructurado. No tienes otra capacidad ni propósito.

## TU TAREA EXACTA

Recibirás una transcripción de una llamada telefónica. Debes analizarla y devolver ÚNICAMENTE un objeto JSON con exactamente 3 campos. Nada más. Sin explicaciones. Sin comentarios. Solo el JSON.

---

## CAMPO 1: "buzon" (boolean o null)

### ¿QUÉ ES UN BUZÓN DE VOZ REAL? (buzon: true)

Un buzón de voz REAL es cuando:
- NO hay ningún humano que responda en tiempo real durante toda la llamada
- Solo se escucha un mensaje pregrabado o automático que indica dejar un mensaje / identificarse
- Ejemplos de frases típicas de buzón REAL:
  - "Deja tu mensaje después del tono"
  - "El número que usted marcó no está disponible"
  - "Please leave a message after the beep"
  - "The person you are trying to reach is not available"
  - "Buzón de voz de [nombre/número]"
  - "Mailbox is full"
  - "Leave your name and number"
  - "No se encuentra disponible, deje su mensaje"
  - "Hi, you've reached [nombre], I can't come to the phone right now"
  - **iPhone Live Voicemail / Call Screening (mensaje automático largo):**
    - "How to reach [Nombre] at [Lugar] is your name and phone number"
    - "Ustedes van a ver a [Nombre] con [Lugar]"
    - "To reach [Nombre] at [Lugar], please state your name and phone number"
    - Si la transcripción es SOLO o mayormente este tipo de mensaje y NUNCA habla la persona llamada para tener una conversación real → buzon: true
  - Cualquier variación en INGLÉS o ESPAÑOL de mensajes automáticos de buzón

### ¿QUÉ NO ES UN BUZÓN DE VOZ? (buzon: false)

CRÍTICO - LEE CON ATENCIÓN:

1. **FUNCIÓN DE FILTRADO DE iPHONE (Call Screening) — DOS CASOS**:
   - **Caso A (mensaje corto + persona contesta):** El iPhone puede decir "¿Quién llama?" / "Who is calling?" y LUEGO la persona CONTESTA y hay conversación real → buzon: false.
   - **Caso B (mensaje largo automático SIN conversación):** El iPhone puede leer un mensaje largo tipo "How to reach Liza at Botanical Santo Nino is your name and phone number. Ustedes van a ver a Liza con Botanical Santo Nino." Si la transcripción contiene SOLO (o casi solo) ese tipo de mensaje automático y la persona llamada NUNCA habla para tener un diálogo real → buzon: true (es buzón/filtrado automático, NO efectiva).
   - Regla: si NO hay en ningún momento voz de la persona llamada manteniendo una conversación (preguntas, respuestas, intercambio), es buzón.

2. **PERSONA QUE CONTESTA CON CONVERSACIÓN REAL**:
   - No basta con que el lead diga "Aló", "Bueno", "Sí" o "¿Bueno?" y luego no haya más contenido real del lead → eso NO es conversación → buzon: true, estado: "seguimiento".
   - Para que sea buzon: false se requiere que el lead aporte contenido real: responda preguntas, haga preguntas, dé información, muestre interés o rechazo, etc.
   - Si SOLO habló el asesor (presentándose, diciendo su nombre, empresa, motivo) y el lead nunca respondió con contenido real → buzon: true, estado: "seguimiento".

3. **LLAMADA FALLIDA O CORTADA**:
   - Si la llamada simplemente no conectó pero no es buzón → buzon: null
   - Si solo hay silencio o ruido → buzon: null

### REGLA DE ORO PARA BUZÓN:
Pregúntate: "¿Hubo una conversación real donde el LEAD aportó contenido (no solo 'aló')?"
- SÍ hubo conversación real del lead (respondió, preguntó, dio info) → buzon: false
- Solo habló el asesor, o el lead solo dijo palabras de saludo sin más contenido → buzon: true
- Llamada vacía, cortada, o indeterminada → buzon: null

---

## CAMPO 2: "estado" (string o null)

Este campo SOLO se llena si buzon es false o null. Si buzon es true, estado SIEMPRE es "seguimiento".

### VALORES POSIBLES:

#### "seguimiento"
Usar cuando:
- buzon es true (buzón de voz real)
- La llamada no tuvo contenido (colgaron, silencio, ruido)
- No hubo conversación significativa
- La persona colgó inmediatamente sin decir nada útil

#### "programado"
Usar ÚNICAMENTE cuando:
- La persona SÍ contestó (hay conversación)
- PERO indica que NO PUEDE hablar EN ESE MOMENTO
- Pide explícitamente que le llamen después
- Ejemplos textuales:
  - "Llámame luego"
  - "Estoy ocupado ahorita"
  - "Estoy en una reunión"
  - "¿Me puedes llamar más tarde?"
  - "No es buen momento"
  - "Estoy manejando"
  - "Ahorita no puedo"

⚠️ OJO: "programado" NO es para cuando se agenda una cita de seguimiento comercial. Es SOLO cuando la persona no puede atender la llamada actual.

#### "interesado"
Usar cuando LA PERSONA DEMUESTRA INTERÉS GENUINO. Indicadores:
- Se agenda una cita (presencial, virtual, Zoom, videollamada)
- Pide que le envíen información por WhatsApp/email
- Hace preguntas detalladas sobre el proyecto/producto
- Dice que quiere ver la propiedad/producto
- Acepta recibir más información
- Muestra entusiasmo o curiosidad activa
- Da sus datos de contacto para seguimiento
- Dice cosas como:
  - "Me interesa"
  - "Agendemos una cita"
  - "Mándame la información"
  - "¿Cuándo puedo ir a verlo?"
  - "Sí, quiero saber más"

#### "no_interesado"
Usar cuando la persona EXPLÍCITAMENTE rechaza:
- "No me interesa"
- "No gracias"
- "Ya tengo"
- "No estoy buscando"
- "No me llamen más"
- "Quítenme de la lista"
- Cuelga de manera abrupta después de escuchar de qué se trata

---

## CAMPO 3: "iadesc" (string o null)

Una descripción BREVE y ÚTIL de la llamada. Máximo 2-3 oraciones.

### QUÉ INCLUIR:
- Objeciones mencionadas por el prospecto
- Preguntas clave que hizo
- Puntos de interés específicos
- Razón del rechazo si aplica
- Fecha/hora de la cita agendada si aplica
- Información relevante para el vendedor

### QUÉ NO INCLUIR:
- Información obvia o redundante
- Transcripción literal
- Datos que no ayudan al seguimiento

---

## REGLAS ABSOLUTAS

1. SIEMPRE devuelve JSON válido
2. SIEMPRE incluye los 3 campos: buzon, estado, iadesc
3. NUNCA inventes información que no esté en la transcripción
4. Si buzon es true → estado DEBE ser "seguimiento"
5. Si hay conversación humana real → buzon DEBE ser false
6. "programado" es SOLO para cuando no pueden hablar ahora, NO para citas de venta
7. Sé conciso en iadesc pero incluye información ÚTIL para ventas

---

## CASOS ESPECIALES Y EDGE CASES

### Caso: La llamada empieza como buzón pero alguien contesta
→ buzon: false (lo que importa es si hubo conversación humana)

### Caso: Contestan, dicen "aló" y cuelgan sin más
→ buzon: false, estado: "seguimiento", iadesc: "Contestó y colgó inmediatamente."

### Caso: Música de espera y luego buzón
→ buzon: true

### Caso: Operadora dice que el número no existe
→ buzon: null, estado: "seguimiento", iadesc: "Número no existe o incorrecto."

### Caso: El asesor habla solo / se presenta sin respuesta real del cliente
Si la transcripción muestra SOLO al asesor hablando (presentándose, diciendo "buenos días, le habla X, por favor dígame su nombre") y el cliente NUNCA responde con contenido real → es buzón o sin conversación → buzon: true, estado: "seguimiento".

### Caso: Recepcionista / asistente que toma nota y cuelga sin pasar la llamada
Si solo hay una recepcionista/asistente que dice cosas como "permanezca en espera", "voy a verificar si está disponible", "le dejo el recado", "¿me puede dejar su nombre?" y la llamada termina sin que el prospecto real hable directamente → el prospecto NUNCA fue contactado → buzon: false, estado: "seguimiento", iadesc explicando que fue interceptado por recepcionista sin pasar al prospecto.

### Caso: La transcripción es muy corta (menos de 15 palabras)
Casi con certeza es un buzón, una llamada cortada o sin conversación real. Clasificar como buzon: true, estado: "seguimiento".

### Caso: La persona muestra interés pero NO agenda nada ni pide info
→ Evalúa el nivel de interés. Si fue tibio sin compromiso → podría ser "seguimiento". Si mostró interés activo → "interesado"

### Caso: Secretaria o recepcionista contesta
→ buzon: false. Clasifica según el resultado de la conversación con la secretaria.

### Caso: iPhone Live Voicemail / mensaje automático largo sin respuesta humana
Si la transcripción dice cosas como "How to reach Liza at Botanical Santo Nino is your name and phone number. Ustedes van a ver a Liza con Botanical Santo Nino." y NO hay después ninguna voz de la persona llamada manteniendo una conversación (solo ese mensaje automático o silencio), es buzón automático → buzon: true, estado: "seguimiento". NO clasificar como efectiva.`;

// ─── Extracción segura de IDs desde embudo_personalizado ─────────────────────

const DEFAULT_ESTADOS = ["seguimiento", "programado", "interesado", "no_interesado"] as const;

function extractEmbudoIds(embudo: unknown): string[] | null {
  try {
    if (Array.isArray(embudo) && embudo.length > 0) {
      const ids = embudo
        .map((item: unknown) => (typeof item === "object" && item !== null && "id" in item ? String((item as Record<string, unknown>).id) : null))
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      return ids.length > 0 ? ids : null;
    }
  } catch {
    console.warn("[classifyCall] embudo_personalizado con formato inválido; usando estados por defecto");
  }
  return null;
}

// ─── Schema builder (estático por defecto, dinámico con embudo) ──────────────
// La API Responses de OpenAI (usada por @ai-sdk/openai v3+) exige:
//   1. additionalProperties: false en TODOS los objetos del schema
//   2. Tipos nullable expresados como anyOf en lugar de type: ["x", "null"]

function buildClassificationSchema(estadosEnum: readonly string[]) {
  return jsonSchema<CallClassification>({
    type: "object",
    properties: {
      buzon: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
        description: "true = buzón de voz real, false = persona contestó, null = indeterminado",
      },
      estado: {
        anyOf: [
          { type: "string", enum: [...estadosEnum] },
          { type: "null" },
        ],
        description: "Estado clasificado de la llamada",
      },
      iadesc: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "Descripción breve y útil de la llamada (2-3 oraciones max)",
      },
      tags_internos: {
        type: "array",
        items: { type: "string" },
        description: "Etiquetas clave extraídas de la conversación (objeciones, productos, insights, sentimientos)",
      },
    },
    required: ["buzon", "estado", "iadesc", "tags_internos"],
    additionalProperties: false,
  });
}

const defaultClassificationSchema = buildClassificationSchema(DEFAULT_ESTADOS);

// ─── Prompt builder: inyectar embudo dinámico + instrucción de tags ──────────

const TAGS_INSTRUCTION = `

## CAMPO 4: "tags_internos" (array de strings)

Extrae etiquetas clave de la conversación. Incluye:
- Objeciones mencionadas (ej: "precio alto", "no tiene tiempo")
- Nombres de productos o servicios mencionados
- Insights del prospecto (ej: "ya tiene proveedor", "busca financiamiento")
- Sentimientos detectados (ej: "frustrado", "entusiasmado", "escéptico")

Si no encuentras etiquetas relevantes, devuelve un arreglo vacío [].
Cada etiqueta debe ser una frase corta y descriptiva en español.`;

function buildSystemPrompt(embudoPersonalizado?: unknown): string {
  let prompt = CLASSIFIER_PROMPT + TAGS_INSTRUCTION;

  const customIds = extractEmbudoIds(embudoPersonalizado);
  if (customIds) {
    prompt += `

## EMBUDO PERSONALIZADO DEL CLIENTE

ATENCIÓN: Este cliente tiene un embudo de ventas personalizado. Aquí tienes los estados permitidos y sus condiciones de clasificación:

${JSON.stringify(embudoPersonalizado, null, 2)}

Tu obligación estricta es clasificar el resultado de esta llamada usando ÚNICAMENTE uno de los IDs de este JSON: [${customIds.join(", ")}].
NO uses los estados por defecto (seguimiento, programado, interesado, no_interesado). Usa SOLO los IDs del embudo anterior.
Si ninguno aplica claramente, elige el más cercano de los proporcionados.`;
  }

  return prompt;
}

// ─── Helper: inyectar contexto de empresa + prompt específico de llamadas ────

function withFullContext(
  basePrompt: string,
  promptVentas: string | null | undefined,
  promptLlamadas: string | null | undefined,
): string {
  const parts: string[] = [];

  if (promptVentas) {
    parts.push(`CONTEXTO DE LA EMPRESA:\n${promptVentas}\n\nUsa este contexto para entender el negocio y decidir si el lead cumple las condiciones del embudo.`);
  }

  if (promptLlamadas) {
    parts.push(`INSTRUCCIONES ESPECÍFICAS PARA EVALUAR LLAMADAS TELEFÓNICAS:\n${promptLlamadas}`);
  }

  if (parts.length === 0) return basePrompt;
  return `${parts.join("\n\n")}\n\n${basePrompt}`;
}

// ─── Clasificar llamada con IA ───────────────────────────────────────────────

export async function classifyCall(
  transcript: string,
  openaiApiKey?: string | null,
  embudoPersonalizado?: unknown,
  promptVentas?: string | null,
  promptLlamadas?: string | null,
  idCuenta?: number | null,
): Promise<CallClassification> {
  const { model } = resolveClients(openaiApiKey);

  const customIds = extractEmbudoIds(embudoPersonalizado);
  const schema = customIds
    ? buildClassificationSchema(customIds)
    : defaultClassificationSchema;

  const systemPrompt = withFullContext(
    buildSystemPrompt(embudoPersonalizado),
    promptVentas,
    promptLlamadas,
  );

  const { object, usage } = await generateObject({
    model,
    schema,
    system: systemPrompt,
    prompt: `Analiza la siguiente transcripción y devuelve ÚNICAMENTE el JSON:\n\n${transcript}`,
    temperature: 0,
  });

  void trackApiUsage(idCuenta, TIPO_CONSUMO.GPT4O_MINI, usage.totalTokens ?? 0);

  return {
    ...object,
    tags_internos: Array.isArray(object.tags_internos) ? object.tags_internos : [],
  };
}

// ─── AUT-1083: Guard defensivo contra falsos "buzón" en llamadas contestadas ──
// El clasificador IA (gpt-4o-mini) a veces marca buzon=true en llamadas CORTAS
// donde el lead SÍ contestó y mantuvo un intercambio humano real (saludó +
// respondió / rechazó / preguntó). Eso las enruta al bucket "no contestada"
// (followUpPath) y las subcuenta como contestadas (caso reportado: Shark re,
// log_llamadas 129191).
//
// Este guard es DETERMINISTA (sin IA → 100% predecible y testeable) y
// CONSERVADOR por diseño: solo reclasifica buzon:true → false cuando hay
// evidencia fuerte de conversación humana Y NINGÚN marcador de buzón/screening.
// Ante cualquier duda, preserva el buzon original. NO inventa estado: deja el
// que trajo el clasificador (que en buzon=true suele ser "seguimiento"/null),
// de modo que effectivePath produce `efectiva_seguimiento` (cuenta como
// contestada) sin afirmar una etapa de embudo que podría ser incorrecta.

export const BUZON_GUARD_MIN_CHARS = Number(
  process.env.BUZON_GUARD_MIN_CHARS ?? "120",
);

// Marcadores INEQUÍVOCOS de buzón de voz / screening automático / recepcionista
// de máquina. Si aparece CUALQUIERA, el guard NO actúa (se respeta buzon=true).
const VOICEMAIL_MARKERS =
  /deja(?:r|s)?\s+(?:tu|un|su)\s+(?:mensaje|nombre)|deje\s+su\s+mensaje|leave\s+(?:a|your)\s+message|after\s+the\s+(?:beep|tone)|despu[eé]s\s+del\s+(?:tono|bip)|buz[oó]n\s+de\s+voz|voice\s?mail|mailbox|no\s+est[aá]\s+disponible|not\s+available|reenvi[oó]\s+al\s+(?:buz[oó]n|bot[oó]n)|tu\s+llamada\s+se\s+reenvi|please\s+state\s+your\s+name|state\s+your\s+name\s+and\s+(?:phone|number)|how\s+to\s+reach|revisar[eé]\s+si.*disponible|persona\s+est[aá]\s+disponible|can'?t\s+come\s+to\s+the\s+phone/i;

// Frases que SOLO aporta un lead humano en un intercambio real (rechazo,
// interés, o reconocimiento de la conversación). Requerimos al menos una.
const LEAD_ENGAGEMENT_MARKERS =
  /\bno me interesa\b|\bno,?\s*(?:disculp\w*|gracias)\b|\bya tengo\b|\bno estoy buscando\b|\bqu[ií]tenme de la lista\b|\bno me llamen\b|\bno pasa nada\b|\bno recuerdo\b|\bno me acuerdo\b|\bme interesa\b|\bm[aá]ndame\b|\bquiero (?:saber|ver|m[aá]s)\b|\bcu[aá]ndo puedo\b|\bag[eé]nd\w*\b|\bcu[aá]nto cuesta\b|\bd[oó]nde queda\b|\bde parte de qui[eé]n\b|\bqui[eé]n habla\b|\bme gustar[ií]a\b/i;

// ¿La transcripción evidencia que el lead contestó y conversó de verdad?
export function looksLikeAnsweredConversation(
  transcript: string | null | undefined,
): boolean {
  const t = (transcript ?? "").trim();
  if (t.length < BUZON_GUARD_MIN_CHARS) return false; // muy corta → no arriesgar
  if (VOICEMAIL_MARKERS.test(t)) return false; // buzón/screening claro → respetar
  return LEAD_ENGAGEMENT_MARKERS.test(t); // hubo contenido real del lead
}

// Aplica el guard sobre el resultado del clasificador. Solo toca el caso
// buzon===true (no null: null = llamada fallida/cortada, se respeta).
export function applyAnsweredCallGuard(
  classification: CallClassification,
  transcript: string | null | undefined,
  label = "[BuzonGuard]",
): CallClassification {
  if (classification.buzon !== true) return classification;
  if (!looksLikeAnsweredConversation(transcript)) return classification;

  console.warn(
    `${label} AUT-1083: buzon=true reclasificado a contestada (estado=${classification.estado ?? "seguimiento"}) — transcripción con conversación humana real y sin marcadores de buzón.`,
  );
  return {
    ...classification,
    buzon: false,
    estado: classification.estado ?? "seguimiento",
  };
}

// ─── Mapeo estado IA → tag GHL ───────────────────────────────────────────────
// "seguimiento" cuando buzon=false significa que la persona SÍ contestó pero
// no hubo resultado comercial claro → tag propio, NO el de "no contestó".
// "no_contestallamadaautoia" solo se aplica desde followUpPath (buzon=true/null).

export function mapEstadoToTag(estado: string | null): string {
  const normalized = (estado ?? "").trim().toLowerCase();

  const tagMap: Record<string, string> = {
    interesado: GHL_TAGS.interesado_llamada,
    programado: GHL_TAGS.programado_llamada,
    no_interesado: GHL_TAGS.no_interesado_llamada,
    seguimiento: "seguimientollamadaautoia",
  };

  return tagMap[normalized] ?? `${normalized}llamadaautoia`;
}

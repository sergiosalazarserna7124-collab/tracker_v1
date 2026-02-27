import OpenAI, { toFile } from "openai";
import { generateObject, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { env } from "../../config/env.js";
import { GHL_TAGS } from "../ghl-api.service.js";

// ─── Clientes IA ──────────────────────────────────────────────────────────────

const whisperClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const aiProvider = createOpenAI({ apiKey: env.OPENAI_API_KEY });
const MODEL = aiProvider("gpt-4o-mini");

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CallClassification {
  buzon: boolean | null;
  estado: string | null;
  iadesc: string | null;
}

// ─── Whisper: transcribir audio ──────────────────────────────────────────────

export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  const file = await toFile(audioBuffer, "recording.mp3", { type: "audio/mpeg" });

  const transcription = await whisperClient.audio.transcriptions.create({
    file,
    model: "whisper-1",
  });

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
- Solo se escucha un mensaje pregrabado que indica dejar un mensaje
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
  - Cualquier variación en INGLÉS o ESPAÑOL de mensajes automáticos de buzón

### ¿QUÉ NO ES UN BUZÓN DE VOZ? (buzon: false)

CRÍTICO - LEE CON ATENCIÓN:

1. **FUNCIÓN DE FILTRADO DE iPHONE (Call Screening)**:
   - El iPhone tiene una función donde al principio puede sonar como buzón
   - Dice cosas como: "¿Quién llama?" o "El teléfono está filtrando esta llamada" o "Who is calling?"
   - PERO luego la persona CONTESTA y hay conversación real
   - Si después del "buzón inicial" hay una conversación humana real → buzon: false

2. **PERSONA QUE CONTESTA**:
   - Si en CUALQUIER momento hay un humano que responde y conversa → buzon: false
   - Aunque sea breve: "Aló", "Bueno", "Diga", "Hello" seguido de conversación → buzon: false

3. **LLAMADA FALLIDA O CORTADA**:
   - Si la llamada simplemente no conectó pero no es buzón → buzon: null
   - Si solo hay silencio o ruido → buzon: null

### REGLA DE ORO PARA BUZÓN:
Pregúntate: "¿Hubo en algún momento una persona humana que respondió y conversó?"
- SÍ hubo persona → buzon: false
- NO hubo persona, solo mensaje pregrabado pidiendo dejar mensaje → buzon: true
- No está claro / llamada vacía → buzon: null

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

### Caso: La persona muestra interés pero NO agenda nada ni pide info
→ Evalúa el nivel de interés. Si fue tibio sin compromiso → podría ser "seguimiento". Si mostró interés activo → "interesado"

### Caso: Secretaria o recepcionista contesta
→ buzon: false. Clasifica según el resultado de la conversación con la secretaria.`;

// La API Responses de OpenAI (usada por @ai-sdk/openai v3+) exige:
//   1. additionalProperties: false en TODOS los objetos del schema
//   2. Tipos nullable expresados como anyOf en lugar de type: ["x", "null"]

const classificationSchema = jsonSchema<CallClassification>({
  type: "object",
  properties: {
    buzon: {
      anyOf: [{ type: "boolean" }, { type: "null" }],
      description: "true = buzón de voz real, false = persona contestó, null = indeterminado",
    },
    estado: {
      anyOf: [
        {
          type: "string",
          enum: ["seguimiento", "programado", "interesado", "no_interesado"],
        },
        { type: "null" },
      ],
      description: "Estado clasificado de la llamada",
    },
    iadesc: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "Descripción breve y útil de la llamada (2-3 oraciones max)",
    },
  },
  required: ["buzon", "estado", "iadesc"],
  additionalProperties: false,
});

export async function classifyCall(transcript: string): Promise<CallClassification> {
  const { object } = await generateObject({
    model: MODEL,
    schema: classificationSchema,
    system: CLASSIFIER_PROMPT,
    prompt: `Analiza la siguiente transcripción y devuelve ÚNICAMENTE el JSON:\n\n${transcript}`,
    temperature: 0,
  });

  return object;
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

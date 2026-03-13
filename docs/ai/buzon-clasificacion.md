# Clasificación de buzón vs llamada efectiva

La IA que clasifica las transcripciones de llamadas (Twilio → Whisper → clasificador) debe decidir si la llamada fue **buzón de voz** (`buzon: true`) o **conversación real** (`buzon: false`). De eso depende si se aplica el tag "no contestada" o se procesa como llamada efectiva (interesado, programado, etc.).

---

## Regla principal

- **buzon: true** → No hubo ninguna persona al otro lado que mantuviera una conversación. Solo mensaje automático (o silencio/ruido).
- **buzon: false** → En algún momento una persona respondió y hubo intercambio real (aunque sea breve).

---

## iPhone: Live Voicemail / Call Screening

Los iPhone pueden mostrar dos comportamientos que afectan la transcripción:

### 1. Mensaje corto + la persona luego contesta

- El teléfono dice cosas como: "¿Quién llama?", "Who is calling?", "El teléfono está filtrando esta llamada".
- **Después** la persona contesta y hay diálogo.
- → **buzon: false** (cuenta como efectiva; clasificar estado según la conversación).

### 2. Mensaje largo automático y nadie habla

- El sistema lee un mensaje largo en inglés y/o español, por ejemplo:
  - *"How to reach Liza at Botanical Santo Nino is your name and phone number."*
  - *"Ustedes van a ver a Liza con Botanical Santo Nino."*
- La transcripción contiene **solo** (o casi solo) ese tipo de frases. La persona llamada **nunca** habla para tener una conversación.
- → **buzon: true** (buzón / filtrado automático). **No** marcar como efectiva ni "seguimiento" en el sentido de "contestó pero sin resultado"; aquí no contestó un humano.

Si se clasifica erróneamente como efectiva "seguimiento", el lead quedará con tag de "contestó" cuando en realidad solo sonó el mensaje automático del iPhone.

---

## Frases típicas que indican buzón (ejemplos)

- "Deja tu mensaje después del tono"
- "Please leave a message after the beep"
- "Leave your name and number"
- "How to reach [Nombre] at [Lugar] is your name and phone number"
- "Ustedes van a ver a [Nombre] con [Lugar]"
- "To reach [Nombre] at [Lugar], please state your name and phone number"
- "Buzón de voz de..."
- "The person you are trying to reach is not available"

Si la transcripción se reduce a estas (o similares) y no hay diálogo posterior de la persona llamada → **buzon: true**.

---

## Dónde se define la lógica

El prompt del clasificador está en:

- `src/services/ai/call-classification.service.ts`  
  - Sección **CAMPO 1: "buzon"** y **CASOS ESPECIALES Y EDGE CASES**.

Cualquier ajuste fino (más ejemplos de frases iPhone, otros operadores, etc.) se hace ahí y se refleja en la documentación de este archivo.

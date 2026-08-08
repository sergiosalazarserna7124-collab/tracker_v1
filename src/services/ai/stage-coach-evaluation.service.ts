import { and, desc, eq } from "drizzle-orm";
import { generateObject, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { drizzleDb } from "../../config/drizzle.js";
import { db as pgPool } from "../../config/database.js";
import { logLlamadas } from "../../db/schema.js";
import { env } from "../../config/env.js";
import { trackApiUsage, TIPO_CONSUMO } from "./track-api-usage.service.js";
import {
  addContactNote,
  removeContactTag,
  safeAddContactTags,
  type CoachEtapaLead,
} from "../ghl-api.service.js";

// ─────────────────────────────────────────────────────────────────────────────
// Coach de ventas POR ETAPA del lead (categorias_leads[].coach).
//
// A diferencia del coach por guion/canal (coach-evaluation.service), este
// evaluador toma en conjunto TODAS las interacciones del contacto —chats,
// llamadas y citas/videollamadas, unidas por el contact ID— y decide si la
// etapa se dio por CUMPLIDA (pasó) o NO según los criterios definidos por el
// coach y el umbral. Aplica tags de resultado y deja una nota accionable.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_UMBRAL = 70;
const DEFAULT_TAG_NO_CUMPLIDO = "etapa_incumplida_autoia";
const MIN_TEXTO_UTIL = 40; // chars mínimos de contexto para que valga la pena evaluar
const MAX_TRANSCRIPT_CHARS = 24_000; // recorte defensivo para el prompt

// ─── Modelo IA ───────────────────────────────────────────────────────────────

const defaultProvider = createOpenAI({ apiKey: env.OPENAI_API_KEY });
const defaultModel = defaultProvider("gpt-4o-mini");

function resolveModel(openaiApiKey?: string | null): LanguageModel {
  if (openaiApiKey) return createOpenAI({ apiKey: openaiApiKey })("gpt-4o-mini");
  return defaultModel;
}

// ─── Recolección de interacciones del contacto ───────────────────────────────

type ChatMessage = { role: string; message: string; timestamp?: string; name?: string };

export interface Interaccion {
  canal: "llamada" | "cita" | "chat";
  ts: Date;
  texto: string;
}

const CANAL_LABEL: Record<Interaccion["canal"], string> = {
  llamada: "LLAMADA",
  cita: "CITA/VIDEOLLAMADA",
  chat: "CHAT",
};

/** Clasifica un registro de log_llamadas en llamada vs cita según tipo_evento. */
function canalDeLlamada(tipoEvento: string | null): "llamada" | "cita" {
  const t = (tipoEvento ?? "").toLowerCase();
  if (t.includes("video") || t.includes("cita") || t.includes("fathom") || t.includes("zoom") || t.includes("meet")) {
    return "cita";
  }
  return "llamada";
}

function chatToTexto(chat: unknown): string {
  if (!Array.isArray(chat)) return "";
  return (chat as ChatMessage[])
    .map((m) => {
      const role = m.role === "lead" ? "Lead" : m.role === "agent" ? "Asesor" : (m.role ?? "");
      return `${role}: ${m.message ?? ""}`.trim();
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Reúne todas las interacciones del contacto: llamadas + citas desde
 * log_llamadas y chats desde chats_logs. Orden cronológico ascendente.
 */
export async function gatherContactInteractions(
  idCuenta: number,
  contactId: string,
): Promise<Interaccion[]> {
  const interacciones: Interaccion[] = [];

  // Llamadas + citas (log_llamadas)
  try {
    const rows = await drizzleDb
      .select({
        tipo_evento: logLlamadas.tipo_evento,
        transcripcion: logLlamadas.transcripcion,
        ia_descripcion: logLlamadas.ia_descripcion,
        ts: logLlamadas.ts,
      })
      .from(logLlamadas)
      .where(and(eq(logLlamadas.id_cuenta, idCuenta), eq(logLlamadas.contact_id_ghl, contactId)))
      .orderBy(desc(logLlamadas.ts))
      .limit(50);
    for (const r of rows) {
      const texto = (r.transcripcion ?? r.ia_descripcion ?? "").trim();
      if (!texto) continue;
      interacciones.push({ canal: canalDeLlamada(r.tipo_evento), ts: r.ts ?? new Date(0), texto });
    }
  } catch (err) {
    console.warn(`[StageCoach] No se pudieron leer llamadas/citas del contacto ${contactId}:`, err);
  }

  // Chats (chats_logs) — no está en el schema de drizzle, se consulta por SQL.
  try {
    const { rows } = await pgPool.query<{ chat: unknown; fecha_y_hora_z: Date | null }>(
      `SELECT chat, fecha_y_hora_z
         FROM chats_logs
        WHERE id_cuenta = $1 AND id_lead = $2
        ORDER BY fecha_y_hora_z DESC NULLS LAST
        LIMIT 50`,
      [idCuenta, contactId],
    );
    for (const r of rows) {
      const texto = chatToTexto(r.chat).trim();
      if (!texto) continue;
      interacciones.push({ canal: "chat", ts: r.fecha_y_hora_z ?? new Date(0), texto });
    }
  } catch (err) {
    console.warn(`[StageCoach] No se pudieron leer chats del contacto ${contactId}:`, err);
  }

  interacciones.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  return interacciones;
}

export function buildContextTranscript(interacciones: Interaccion[]): string {
  const bloques = interacciones.map((i) => {
    const fecha = i.ts.getTime() > 0 ? i.ts.toISOString().slice(0, 16).replace("T", " ") : "sin fecha";
    return `### ${CANAL_LABEL[i.canal]} — ${fecha}\n${i.texto}`;
  });
  let texto = bloques.join("\n\n");
  if (texto.length > MAX_TRANSCRIPT_CHARS) {
    // Conservar lo más reciente (final del string).
    texto = "[…contexto anterior omitido…]\n\n" + texto.slice(-MAX_TRANSCRIPT_CHARS);
  }
  return texto;
}

// ─── Evaluación IA ───────────────────────────────────────────────────────────

export interface StageCoachResult {
  paso: boolean;
  score: number;
  evidencia: string;
  nota_accionable: string;
}

const evalSchema = jsonSchema<StageCoachResult>({
  type: "object",
  properties: {
    paso: {
      type: "boolean",
      description: "true si, tomando en conjunto TODAS las interacciones, la etapa se dio por cumplida según los criterios",
    },
    score: {
      type: "number",
      minimum: 0,
      maximum: 100,
      description: "Porcentaje de cumplimiento de los criterios de la etapa (0-100)",
    },
    evidencia: {
      type: "string",
      description: "Evidencia breve del contexto que justifica el resultado (máx. 2 oraciones)",
    },
    nota_accionable: {
      type: "string",
      description: "1-2 recomendaciones concretas para el asesor sobre qué falta o qué reforzar (máx. 2 oraciones)",
    },
  },
  required: ["paso", "score", "evidencia", "nota_accionable"],
  additionalProperties: false,
});

function buildSystemPrompt(coach: CoachEtapaLead, etapaNombre: string, umbral: number): string {
  return `Eres un coach de ventas. Evalúas el AVANCE de un lead en una etapa concreta de su proceso comercial.

## ETAPA
"${etapaNombre}"

## QUÉ DEBE PASAR EN ESTA ETAPA (criterios de cumplimiento)
${coach.criterios}

## CONTEXTO QUE RECIBES
Recibes, unidas por el mismo contacto y en orden cronológico, TODAS sus interacciones: chats, llamadas y citas/videollamadas. Debes evaluarlas EN CONJUNTO, no una por una: un criterio puede cumplirse en un chat y otro en una llamada posterior.

## INSTRUCCIONES
1. Determina si, sumando todo lo ocurrido, la etapa se dio por CUMPLIDA (paso=true) o no.
2. Asigna un score 0-100 de cumplimiento de los criterios.
3. El umbral de aprobación es ${umbral}%. Sé consistente: si paso=true el score debe ser ≥ ${umbral}, si paso=false debe ser < ${umbral}.
4. La evidencia y la nota deben ser breves (máx. 2 oraciones cada una) y en español.
5. No inventes: básate solo en el contexto entregado.`;
}

export async function evaluateStageCoach(
  transcript: string,
  coach: CoachEtapaLead,
  etapaNombre: string,
  openaiApiKey?: string | null,
  idCuenta?: number | null,
): Promise<StageCoachResult> {
  const umbral = coach.umbral ?? DEFAULT_UMBRAL;
  const model = resolveModel(openaiApiKey);

  const { object, usage } = await generateObject({
    model,
    schema: evalSchema,
    system: buildSystemPrompt(coach, etapaNombre, umbral),
    prompt: `Evalúa el siguiente contexto de interacciones del contacto:\n\n${transcript}`,
    temperature: 0,
  });

  void trackApiUsage(idCuenta ?? null, TIPO_CONSUMO.GPT4O_MINI, usage.totalTokens ?? 0);

  const score = Math.max(0, Math.min(100, Math.round(object.score)));
  // Fuente de verdad del "pasó": el umbral. Respetamos el score del modelo.
  const paso = score >= umbral;
  return { paso, score, evidencia: object.evidencia, nota_accionable: object.nota_accionable };
}

// ─── Decisión de tags + nota (pura, sin side-effects) ────────────────────────

export interface CoachOutcome {
  /** true si el resultado cambia el estado del contacto (hay algo que aplicar). */
  changed: boolean;
  tagsToAdd: string[];
  tagsToRemove: string[];
  noteBody: string;
}

/**
 * Decide qué tags añadir/quitar y qué nota escribir a partir del resultado del
 * coach y los tags actuales del contacto. Idempotente: si el contacto ya está
 * en el estado del resultado, `changed=false`. Pura y testeable.
 */
export function decideCoachOutcome(
  result: StageCoachResult,
  coach: CoachEtapaLead,
  etapaNombre: string,
  contactTags?: string[] | null,
): CoachOutcome {
  const tagsCumplido = (coach.tags_cumplido ?? []).map((t) => t.trim()).filter(Boolean);
  const tagsNoCumplido = (coach.tags_no_cumplido ?? []).map((t) => t.trim()).filter(Boolean);
  const desiredTags = result.paso ? tagsCumplido : (tagsNoCumplido.length > 0 ? tagsNoCumplido : [DEFAULT_TAG_NO_CUMPLIDO]);
  const oppositeTags = result.paso ? tagsNoCumplido : tagsCumplido;

  const currentSet = new Set((contactTags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean));
  const tagsToRemove = oppositeTags.filter((t) => currentSet.has(t.toLowerCase()));
  const tagsToAdd = desiredTags.filter((t) => !currentSet.has(t.toLowerCase()));
  const allDesiredPresent = desiredTags.every((t) => currentSet.has(t.toLowerCase()));

  // Solo consideramos "sin cambios" cuando conocemos los tags actuales.
  const changed = !(contactTags != null && allDesiredPresent && tagsToRemove.length === 0);

  const estado = result.paso ? "✅ Etapa CUMPLIDA" : "⚠️ Etapa NO cumplida";
  const noteBody = `🎯 Coach de ventas — ${etapaNombre}\n${estado} · Cumplimiento: ${result.score}%\n\nEvidencia: ${result.evidencia}\n\nRecomendación: ${result.nota_accionable}`;

  return { changed, tagsToAdd, tagsToRemove, noteBody };
}

// ─── Orquestador (gather → evaluate → aplicar tags + nota) ────────────────────

export interface RunContactStageCoachParams {
  idCuenta: number;
  contactId: string;
  bearerToken: string;
  locationId?: string | null;
  coach: CoachEtapaLead;
  etapaNombre: string;
  /** Tags actuales del contacto, para no re-notificar cuando el estado no cambia. */
  contactTags?: string[] | null;
  openaiApiKey?: string | null;
  /** Interacción recién ocurrida (aún no persistida), para incluirla ya. */
  currentInteraction?: { canal: Interaccion["canal"]; texto: string } | null;
  logPrefix?: string;
}

/**
 * Evalúa el coach de la etapa para un contacto, uniendo todas sus
 * interacciones por contact ID. Idempotente: usa los tags de resultado del
 * contacto como estado, así solo aplica tags/nota cuando el resultado cambia.
 * Fail-open: cualquier error se registra pero nunca se propaga.
 */
export async function runContactStageCoach(params: RunContactStageCoachParams): Promise<void> {
  const {
    idCuenta, contactId, bearerToken, locationId, coach, etapaNombre,
    openaiApiKey, currentInteraction, contactTags,
  } = params;
  const prefix = params.logPrefix ?? "[StageCoach]";

  if (!coach?.criterios?.trim()) return;

  try {
    const interacciones = await gatherContactInteractions(idCuenta, contactId);
    if (currentInteraction?.texto?.trim()) {
      interacciones.push({ canal: currentInteraction.canal, ts: new Date(), texto: currentInteraction.texto.trim() });
    }

    const transcript = buildContextTranscript(interacciones);
    if (transcript.trim().length < MIN_TEXTO_UTIL) {
      console.info(`${prefix} Contexto insuficiente para evaluar contacto ${contactId} (etapa "${etapaNombre}")`);
      return;
    }

    const result = await evaluateStageCoach(transcript, coach, etapaNombre, openaiApiKey, idCuenta);
    const outcome = decideCoachOutcome(result, coach, etapaNombre, contactTags);

    // Sin cambios: ya tiene los tags de este resultado y ninguno del opuesto.
    if (!outcome.changed) {
      console.info(`${prefix} Sin cambios para contacto ${contactId} (etapa "${etapaNombre}", ${result.paso ? "cumple" : "no cumple"} ${result.score}%)`);
      return;
    }

    // Quitar tags del resultado opuesto (transición de estado).
    for (const t of outcome.tagsToRemove) {
      try { await removeContactTag(contactId, bearerToken, t); }
      catch (err) { console.warn(`${prefix} No se pudo quitar tag "${t}" de ${contactId}:`, err); }
    }

    // Aplicar tags del resultado actual (los que aún no tiene el contacto).
    if (outcome.tagsToAdd.length > 0) {
      try { await safeAddContactTags(contactId, bearerToken, outcome.tagsToAdd, locationId ?? undefined); }
      catch (err) { console.warn(`${prefix} No se pudieron aplicar tags a ${contactId}:`, err); }
    }

    // Nota accionable en GHL.
    try { await addContactNote(contactId, bearerToken, outcome.noteBody); }
    catch (err) { console.warn(`${prefix} No se pudo escribir la nota del coach en ${contactId}:`, err); }

    console.info(`${prefix} Contacto ${contactId} etapa "${etapaNombre}": ${result.paso ? "cumple" : "no cumple"} (${result.score}%)`);
  } catch (err) {
    console.error(`${prefix} Error evaluando coach de etapa para contacto ${contactId} (fail-open):`, err instanceof Error ? err.message : err);
  }
}

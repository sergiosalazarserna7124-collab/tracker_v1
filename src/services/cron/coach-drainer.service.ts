import { db as pgPool } from "../../config/database.js";
import { drizzleDb } from "../../config/drizzle.js";
import { evaluacionesCoach, guionesCoach, cuentas } from "../../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { withRetry } from "../../utils/retry.utils.js";
import { evaluateCallAgainstGuion } from "../ai/coach-evaluation.service.js";
import type { NotaPromptConfig } from "../ai/coach-evaluation.service.js";
import {
  safeAddContactTags,
  createLocationTag,
  createContactTask,
} from "../ghl-api.service.js";
import { savePendingTag } from "../ghl-token-guard.service.js";
import type { SeccionGuion, CanalCoach } from "../data/coach-guion.service.js";

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface CoachCuentaRow {
  id_cuenta: number;
  openai_api_key: string | null;
  token_ghl: string | null;
  locationid: string | null;
  categorias_llamadas: unknown;
  zona_horaria_iana: string | null;
  ghl_native_task_workflow: boolean;
  exclusiones_coach: unknown;
}

interface ExclusionRegla {
  canal: string;
  campo: string;
  operador: "eq" | "neq" | "contains" | "not_contains";
  valor: string;
}

interface ExclusionesConfig {
  reglas: ExclusionRegla[];
}

interface EvalCandidate {
  id: number;
  id_cuenta: number;
  transcript: string;
  contact_id_ghl: string | null;
  canal: CanalCoach;
  estado_resultado: string | null;
  tipo_evento: string | null;
}

interface ChatMessage {
  role: string;
  name: string;
  message: string;
  timestamp: string;
}

export interface CoachDrainerResult {
  cuentas_procesadas: number;
  llamadas_evaluadas: number;
  chats_evaluados: number;
  videollamadas_evaluadas: number;
  llamadas_skip: number;
  tags_aplicados: number;
  tareas_creadas: number;
  errores: number;
}

// ─── Constantes ──────────────────────────────────────────────────────────────

const MIN_TRANSCRIPT_CHARS = 120;
const MAX_EVALUATIONS_PER_RUN = 30;
const MAX_RUNTIME_MS = 240_000;
const COACH_TAG = "incumplimiento_guion_autoia";

const ESTADOS_EFECTIVOS = new Set([
  "calificada", "no_calificada",
  "interesado", "no_interesado",
  "programado", "seguimiento",
  "confirmado", "reagendado", "agendado",
  "cerrada",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Conversión chat JSONB → texto plano ────────────────────────────────────

function chatJsonToTranscript(chatJson: unknown): string | null {
  if (!Array.isArray(chatJson)) return null;
  const messages = chatJson as ChatMessage[];
  if (messages.length === 0) return null;

  const lines = messages
    .filter((m) => typeof m.message === "string" && m.message.trim() !== "")
    .map((m) => {
      const role = m.role === "lead" ? (m.name || "Lead") : (m.name || "Asesor");
      return `${role}: ${m.message}`;
    });

  const text = lines.join("\n");
  return text.length >= MIN_TRANSCRIPT_CHARS ? text : null;
}

// ─── Drainer principal ──────────────────────────────────────────────────────

export async function runCoachDrainer(): Promise<CoachDrainerResult> {
  const startTime = Date.now();
  let evaluadasLlamadas = 0;
  let evaluadasChats = 0;
  let evaluadasVideo = 0;
  let skipped = 0;
  let tagsApplied = 0;
  let tareasCreadas = 0;
  let errors = 0;

  const cuentasResult = await withRetry(
    () => pgPool.query<CoachCuentaRow>(
      `SELECT c.id_cuenta, c.openai_api_key, c.token_ghl, c.locationid,
              c.categorias_llamadas, c.zona_horaria_iana, c.ghl_native_task_workflow,
              c.exclusiones_coach
       FROM cuentas c
       WHERE c.coach_habilitado = true
         AND (c.estado_cuenta NOT IN ('cancelado', 'inactivo') OR c.estado_cuenta IS NULL)`,
    ),
    { label: "coachDrainer/getCuentas" },
  );

  const cuentasList = cuentasResult.rows;
  const totalEvaluated = () => evaluadasLlamadas + evaluadasChats + evaluadasVideo;
  console.info(`[coachDrainer] ${cuentasList.length} cuentas con coach habilitado`);

  if (cuentasList.length === 0) {
    return { cuentas_procesadas: 0, llamadas_evaluadas: 0, chats_evaluados: 0, videollamadas_evaluadas: 0, llamadas_skip: 0, tags_aplicados: 0, tareas_creadas: 0, errores: 0 };
  }

  for (const cuenta of cuentasList) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      console.warn("[coachDrainer] Circuit breaker activado");
      break;
    }
    if (totalEvaluated() >= MAX_EVALUATIONS_PER_RUN) {
      console.info("[coachDrainer] Límite de evaluaciones alcanzado");
      break;
    }

    const guiones = await drizzleDb
      .select()
      .from(guionesCoach)
      .where(and(eq(guionesCoach.id_cuenta, cuenta.id_cuenta), eq(guionesCoach.activo, true)));

    if (guiones.length === 0) {
      continue;
    }

    const guionsByCanal = new Map<CanalCoach, Map<string, typeof guiones[0]>>();
    for (const g of guiones) {
      const canal = (g.canal ?? "llamada") as CanalCoach;
      if (!guionsByCanal.has(canal)) {
        guionsByCanal.set(canal, new Map());
      }
      guionsByCanal.get(canal)?.set(g.categoria_llamada_id, g);
    }

    const candidates: EvalCandidate[] = [];

    if (guionsByCanal.has("llamada")) {
      const rows = await fetchLlamadaCandidates(cuenta.id_cuenta);
      candidates.push(...rows);
    }

    if (guionsByCanal.has("chat")) {
      const rows = await fetchChatCandidates(cuenta.id_cuenta);
      candidates.push(...rows);
    }

    if (guionsByCanal.has("videollamada")) {
      const rows = await fetchVideollamadaCandidates(cuenta.id_cuenta);
      candidates.push(...rows);
    }

    if (candidates.length === 0) continue;

    console.info(
      `[coachDrainer] cuenta=${cuenta.id_cuenta}: ${candidates.length} candidatos pendientes de evaluación`,
    );

    const exclusiones = parseExclusiones(cuenta.exclusiones_coach);

    for (const candidate of candidates) {
      if (totalEvaluated() >= MAX_EVALUATIONS_PER_RUN) break;
      if (Date.now() - startTime > MAX_RUNTIME_MS) break;

      if (candidate.canal === "llamada") {
        const estado = (candidate.estado_resultado ?? "").toLowerCase().trim().replace(/\s+/g, "_");
        if (!ESTADOS_EFECTIVOS.has(estado)) {
          skipped++;
          continue;
        }
        if (candidate.tipo_evento === "voz_callai") {
          skipped++;
          continue;
        }
      }

      if (shouldExclude(candidate, exclusiones)) {
        skipped++;
        continue;
      }

      const canalMap = guionsByCanal.get(candidate.canal);
      if (!canalMap) {
        skipped++;
        continue;
      }

      const guion = resolveGuionForCanal(canalMap, cuenta.categorias_llamadas);
      if (!guion) {
        skipped++;
        continue;
      }

      const secciones = guion.secciones as unknown as SeccionGuion[];
      if (!Array.isArray(secciones) || secciones.length === 0) {
        skipped++;
        continue;
      }

      const label = `[coachDrainer c=${cuenta.id_cuenta} ${candidate.canal}=${candidate.id}]`;

      const notaConfig: NotaPromptConfig = {
        nota_cumplido: guion.nota_cumplido,
        nota_no_cumplido: guion.nota_no_cumplido,
      };

      try {
        const result = await evaluateCallAgainstGuion(
          candidate.transcript,
          secciones,
          guion.umbral,
          cuenta.openai_api_key,
          cuenta.id_cuenta,
          candidate.canal,
          notaConfig,
        );

        await drizzleDb.insert(evaluacionesCoach).values({
          id_cuenta: cuenta.id_cuenta,
          log_llamada_id: candidate.id,
          canal: candidate.canal,
          guion_id: guion.id,
          guion_version: guion.version,
          scores_secciones: result.scores as unknown as Record<string, unknown>,
          score_total: result.score_total,
          cumple_umbral: result.cumple_umbral,
          secciones_faltantes_must_have: result.secciones_faltantes_must_have as unknown as Record<string, unknown>,
          nota_accionable: result.nota_accionable,
        });

        if (candidate.canal === "llamada") evaluadasLlamadas++;
        else if (candidate.canal === "chat") evaluadasChats++;
        else evaluadasVideo++;

        const tagsToApply: string[] = result.cumple_umbral
          ? (guion.tags_cumplido as unknown as string[] | null) ?? []
          : (guion.tags_no_cumplido as unknown as string[] | null) ?? [COACH_TAG];

        if (tagsToApply.length > 0 && candidate.contact_id_ghl && cuenta.token_ghl && cuenta.locationid) {
          const ghlResult = await applyCoachTagsAndTask(
            candidate.contact_id_ghl,
            cuenta.token_ghl,
            cuenta.locationid,
            cuenta.id_cuenta,
            tagsToApply,
            result.nota_accionable,
            result.score_total,
            guion.umbral,
            cuenta.ghl_native_task_workflow,
            !result.cumple_umbral,
            label,
          );

          if (ghlResult.tags) tagsApplied += ghlResult.tags;
          if (ghlResult.tarea) tareasCreadas++;

          await drizzleDb
            .update(evaluacionesCoach)
            .set({ ghl_tag_applied: ghlResult.appliedTagNames })
            .where(
              and(
                eq(evaluacionesCoach.id_cuenta, cuenta.id_cuenta),
                eq(evaluacionesCoach.canal, candidate.canal),
                eq(evaluacionesCoach.log_llamada_id, candidate.id),
              ),
            );
        }

        console.info(
          `${label} score=${result.score_total}/${guion.umbral} cumple=${result.cumple_umbral} must_have_fail=${result.secciones_faltantes_must_have.length}`,
        );
      } catch (err) {
        errors++;
        console.error(`${label} Error:`, err instanceof Error ? err.message : err);
      }

      await sleep(500);
    }
  }

  const total = evaluadasLlamadas + evaluadasChats + evaluadasVideo;
  console.info(
    `[coachDrainer] Fin: evaluadas=${total} (llamadas=${evaluadasLlamadas} chats=${evaluadasChats} video=${evaluadasVideo}) skip=${skipped} tags=${tagsApplied} tareas=${tareasCreadas} errores=${errors}`,
  );

  return {
    cuentas_procesadas: cuentasList.length,
    llamadas_evaluadas: evaluadasLlamadas,
    chats_evaluados: evaluadasChats,
    videollamadas_evaluadas: evaluadasVideo,
    llamadas_skip: skipped,
    tags_aplicados: tagsApplied,
    tareas_creadas: tareasCreadas,
    errores: errors,
  };
}

// ─── Fetchers por canal ─────────────────────────────────────────────────────

async function fetchLlamadaCandidates(idCuenta: number): Promise<EvalCandidate[]> {
  const result = await withRetry(
    () => pgPool.query<{
      id: number;
      id_cuenta: number;
      transcripcion: string;
      contact_id_ghl: string | null;
      estado_resultado: string | null;
      tipo_evento: string;
    }>(
      `SELECT ll.id, ll.id_cuenta, ll.transcripcion, ll.contact_id_ghl,
              ll.estado_resultado, ll.tipo_evento
       FROM log_llamadas ll
       WHERE ll.id_cuenta = $1
         AND ll.transcripcion IS NOT NULL
         AND LENGTH(ll.transcripcion) >= $2
         AND ll.ts >= NOW() - INTERVAL '48 hours'
         AND ll.id NOT IN (
           SELECT ec.log_llamada_id FROM evaluaciones_coach ec
           WHERE ec.id_cuenta = $1 AND ec.canal = 'llamada'
         )
       ORDER BY ll.ts DESC
       LIMIT 20`,
      [idCuenta, MIN_TRANSCRIPT_CHARS],
    ),
    { label: `coachDrainer/getLlamadas/${idCuenta}` },
  );

  return result.rows.map((r) => ({
    id: r.id,
    id_cuenta: r.id_cuenta,
    transcript: r.transcripcion,
    contact_id_ghl: r.contact_id_ghl,
    canal: "llamada" as const,
    estado_resultado: r.estado_resultado,
    tipo_evento: r.tipo_evento,
  }));
}

async function fetchChatCandidates(idCuenta: number): Promise<EvalCandidate[]> {
  const result = await withRetry(
    () => pgPool.query<{
      id_evento: number;
      id_cuenta: number;
      chat: unknown;
      id_lead: string | null;
    }>(
      `SELECT cl.id_evento, cl.id_cuenta, cl.chat, cl.id_lead
       FROM chats_logs cl
       WHERE cl.id_cuenta = $1
         AND cl.chat IS NOT NULL
         AND jsonb_array_length(cl.chat) >= 3
         AND cl.fecha_y_hora_z >= NOW() - INTERVAL '48 hours'
         AND COALESCE(cl.excluida_dashboard, false) = false
         AND cl.id_evento NOT IN (
           SELECT ec.log_llamada_id FROM evaluaciones_coach ec
           WHERE ec.id_cuenta = $1 AND ec.canal = 'chat'
         )
       ORDER BY cl.fecha_y_hora_z DESC
       LIMIT 20`,
      [idCuenta],
    ),
    { label: `coachDrainer/getChats/${idCuenta}` },
  );

  const candidates: EvalCandidate[] = [];
  for (const r of result.rows) {
    const transcript = chatJsonToTranscript(r.chat);
    if (!transcript) continue;

    candidates.push({
      id: r.id_evento,
      id_cuenta: r.id_cuenta,
      transcript,
      contact_id_ghl: r.id_lead,
      canal: "chat",
      estado_resultado: null,
      tipo_evento: null,
    });
  }

  return candidates;
}

async function fetchVideollamadaCandidates(idCuenta: number): Promise<EvalCandidate[]> {
  const result = await withRetry(
    () => pgPool.query<{
      id_registro_agenda: number;
      id_cuenta: number;
      transcripcion_fathom: string;
      ghl_contact_id: string | null;
    }>(
      `SELECT a.id_registro_agenda, a.id_cuenta, a.transcripcion_fathom, a.ghl_contact_id
       FROM resumenes_diarios_agendas a
       WHERE a.id_cuenta = $1
         AND a.transcripcion_fathom IS NOT NULL
         AND LENGTH(a.transcripcion_fathom) >= $2
         AND a.fathom_processed_at >= NOW() - INTERVAL '48 hours'
         AND a.id_registro_agenda NOT IN (
           SELECT ec.log_llamada_id FROM evaluaciones_coach ec
           WHERE ec.id_cuenta = $1 AND ec.canal = 'videollamada'
         )
       ORDER BY a.fathom_processed_at DESC
       LIMIT 20`,
      [idCuenta, MIN_TRANSCRIPT_CHARS],
    ),
    { label: `coachDrainer/getVideollamadas/${idCuenta}` },
  );

  return result.rows.map((r) => ({
    id: r.id_registro_agenda,
    id_cuenta: r.id_cuenta,
    transcript: r.transcripcion_fathom,
    contact_id_ghl: r.ghl_contact_id,
    canal: "videollamada" as const,
    estado_resultado: null,
    tipo_evento: null,
  }));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveGuionForCanal(
  guionMap: Map<string, typeof guionesCoach.$inferSelect>,
  categoriasLlamadas: unknown,
): typeof guionesCoach.$inferSelect | null {
  if (guionMap.size === 1) {
    return guionMap.values().next().value ?? null;
  }

  if (Array.isArray(categoriasLlamadas)) {
    for (const cat of categoriasLlamadas as Array<{ id: string }>) {
      const guion = guionMap.get(cat.id);
      if (guion) return guion;
    }
  }

  return null;
}

function parseExclusiones(raw: unknown): ExclusionesConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.reglas)) return null;
  const reglas: ExclusionRegla[] = [];
  for (const r of obj.reglas) {
    if (typeof r !== "object" || r === null) continue;
    const rule = r as Record<string, unknown>;
    if (typeof rule.canal !== "string" || typeof rule.campo !== "string" ||
        typeof rule.operador !== "string" || typeof rule.valor !== "string") continue;
    reglas.push({
      canal: rule.canal,
      campo: rule.campo,
      operador: rule.operador as ExclusionRegla["operador"],
      valor: rule.valor,
    });
  }
  return reglas.length > 0 ? { reglas } : null;
}

function shouldExclude(candidate: EvalCandidate, exclusiones: ExclusionesConfig | null): boolean {
  if (!exclusiones) return false;
  for (const regla of exclusiones.reglas) {
    if (regla.canal !== "todos" && regla.canal !== candidate.canal) continue;
    const fieldValue = getCandidateField(candidate, regla.campo);
    if (matchesRule(fieldValue, regla.operador, regla.valor)) return true;
  }
  return false;
}

function getCandidateField(candidate: EvalCandidate, campo: string): string {
  switch (campo) {
    case "estado_resultado": return (candidate.estado_resultado ?? "").toLowerCase().trim().replace(/\s+/g, "_");
    case "tipo_evento": return candidate.tipo_evento ?? "";
    case "canal": return candidate.canal;
    default: return "";
  }
}

function matchesRule(fieldValue: string, operador: ExclusionRegla["operador"], valor: string): boolean {
  const normalizedValor = valor.toLowerCase().trim();
  switch (operador) {
    case "eq": return fieldValue === normalizedValor;
    case "neq": return fieldValue !== normalizedValor;
    case "contains": return fieldValue.includes(normalizedValor);
    case "not_contains": return !fieldValue.includes(normalizedValor);
    default: return false;
  }
}

async function applyCoachTagsAndTask(
  contactId: string,
  tokenGhl: string,
  locationId: string,
  idCuenta: number,
  tags: string[],
  notaAccionable: string,
  scoreTotal: number,
  umbral: number,
  ghlNativeTaskWorkflow: boolean,
  createTask: boolean,
  label: string,
): Promise<{ tags: number; tarea: boolean; appliedTagNames: string | null }> {
  let tagsApplied = 0;
  let tareaCreated = false;

  if (tags.length > 0) {
    try {
      for (const tag of tags) {
        await createLocationTag(locationId, tokenGhl, tag);
      }
      await safeAddContactTags(contactId, tokenGhl, tags, locationId);
      tagsApplied = tags.length;
    } catch (err) {
      const isTokenInvalid = (err as Error & { isTokenInvalid?: boolean }).isTokenInvalid;
      if (isTokenInvalid) {
        for (const tag of tags) {
          await savePendingTag(idCuenta, contactId, tag, "Token GHL inválido (coach)");
        }
      } else {
        console.error(`${label} Error aplicando tags coach:`, err);
      }
    }
  }

  if (createTask && !ghlNativeTaskWorkflow) {
    try {
      const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await createContactTask(contactId, tokenGhl, {
        title: `Coach IA — Score: ${scoreTotal}/${umbral}`,
        body: notaAccionable,
        dueDate,
      });
      tareaCreated = true;
    } catch (err) {
      console.error(`${label} Error creando tarea coach:`, err);
    }
  }

  return {
    tags: tagsApplied,
    tarea: tareaCreated,
    appliedTagNames: tagsApplied > 0 ? tags.join(",") : null,
  };
}

import { db as pgPool } from "../../config/database.js";
import { drizzleDb } from "../../config/drizzle.js";
import { evaluacionesCoach, guionesCoach, cuentas } from "../../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { withRetry } from "../../utils/retry.utils.js";
import { evaluateCallAgainstGuion } from "../ai/coach-evaluation.service.js";
import {
  safeAddContactTags,
  createLocationTag,
  createContactTask,
} from "../ghl-api.service.js";
import { savePendingTag } from "../ghl-token-guard.service.js";
import type { SeccionGuion } from "../data/coach-guion.service.js";

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface CoachCuentaRow {
  id_cuenta: number;
  openai_api_key: string | null;
  token_ghl: string | null;
  locationid: string | null;
  categorias_llamadas: unknown;
  zona_horaria_iana: string | null;
  ghl_native_task_workflow: boolean;
}

interface LlamadaCoachRow {
  id: number;
  id_cuenta: number;
  transcripcion: string;
  contact_id_ghl: string | null;
  estado_resultado: string | null;
  tipo_evento: string;
  duracion_segundos: number | null;
}

export interface CoachDrainerResult {
  cuentas_procesadas: number;
  llamadas_evaluadas: number;
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

// ─── Drainer principal ──────────────────────────────────────────────────────

export async function runCoachDrainer(): Promise<CoachDrainerResult> {
  const startTime = Date.now();
  let evaluadas = 0;
  let skipped = 0;
  let tagsApplied = 0;
  let tareasCreadas = 0;
  let errors = 0;

  const cuentasResult = await withRetry(
    () => pgPool.query<CoachCuentaRow>(
      `SELECT c.id_cuenta, c.openai_api_key, c.token_ghl, c.locationid,
              c.categorias_llamadas, c.zona_horaria_iana, c.ghl_native_task_workflow
       FROM cuentas c
       WHERE c.coach_habilitado = true
         AND (c.estado_cuenta NOT IN ('cancelado', 'inactivo') OR c.estado_cuenta IS NULL)`,
    ),
    { label: "coachDrainer/getCuentas" },
  );

  const cuentasList = cuentasResult.rows;
  console.info(`[coachDrainer] ${cuentasList.length} cuentas con coach habilitado`);

  if (cuentasList.length === 0) {
    return { cuentas_procesadas: 0, llamadas_evaluadas: 0, llamadas_skip: 0, tags_aplicados: 0, tareas_creadas: 0, errores: 0 };
  }

  for (const cuenta of cuentasList) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      console.warn("[coachDrainer] Circuit breaker activado");
      break;
    }
    if (evaluadas >= MAX_EVALUATIONS_PER_RUN) {
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

    const guionMap = new Map<string, typeof guiones[0]>();
    for (const g of guiones) {
      guionMap.set(g.categoria_llamada_id, g);
    }

    const llamadasResult = await withRetry(
      () => pgPool.query<LlamadaCoachRow>(
        `SELECT ll.id, ll.id_cuenta, ll.transcripcion, ll.contact_id_ghl,
                ll.estado_resultado, ll.tipo_evento, ll.duracion_segundos
         FROM log_llamadas ll
         WHERE ll.id_cuenta = $1
           AND ll.transcripcion IS NOT NULL
           AND LENGTH(ll.transcripcion) >= $2
           AND ll.ts >= NOW() - INTERVAL '48 hours'
           AND ll.id NOT IN (
             SELECT ec.log_llamada_id FROM evaluaciones_coach ec
             WHERE ec.id_cuenta = $1
           )
         ORDER BY ll.ts DESC
         LIMIT 20`,
        [cuenta.id_cuenta, MIN_TRANSCRIPT_CHARS],
      ),
      { label: `coachDrainer/getLlamadas/${cuenta.id_cuenta}` },
    );

    if (llamadasResult.rows.length === 0) continue;

    console.info(
      `[coachDrainer] cuenta=${cuenta.id_cuenta}: ${llamadasResult.rows.length} llamadas pendientes de evaluación`,
    );

    for (const llamada of llamadasResult.rows) {
      if (evaluadas >= MAX_EVALUATIONS_PER_RUN) break;
      if (Date.now() - startTime > MAX_RUNTIME_MS) break;

      const estado = (llamada.estado_resultado ?? "").toLowerCase().trim().replace(/\s+/g, "_");
      if (!ESTADOS_EFECTIVOS.has(estado)) {
        skipped++;
        continue;
      }

      if (llamada.tipo_evento === "voz_callai") {
        skipped++;
        continue;
      }

      const guion = resolveGuionForCall(guionMap, cuenta.categorias_llamadas);
      if (!guion) {
        skipped++;
        continue;
      }

      const secciones = guion.secciones as unknown as SeccionGuion[];
      if (!Array.isArray(secciones) || secciones.length === 0) {
        skipped++;
        continue;
      }

      const label = `[coachDrainer c=${cuenta.id_cuenta} ll=${llamada.id}]`;

      try {
        const result = await evaluateCallAgainstGuion(
          llamada.transcripcion,
          secciones,
          guion.umbral,
          cuenta.openai_api_key,
          cuenta.id_cuenta,
        );

        await drizzleDb.insert(evaluacionesCoach).values({
          id_cuenta: cuenta.id_cuenta,
          log_llamada_id: llamada.id,
          guion_id: guion.id,
          guion_version: guion.version,
          scores_secciones: result.scores as unknown as Record<string, unknown>,
          score_total: result.score_total,
          cumple_umbral: result.cumple_umbral,
          secciones_faltantes_must_have: result.secciones_faltantes_must_have as unknown as Record<string, unknown>,
          nota_accionable: result.nota_accionable,
        });

        evaluadas++;

        if (!result.cumple_umbral && llamada.contact_id_ghl && cuenta.token_ghl && cuenta.locationid) {
          const ghlResult = await applyCoachTagAndTask(
            llamada.contact_id_ghl,
            cuenta.token_ghl,
            cuenta.locationid,
            cuenta.id_cuenta,
            result.nota_accionable,
            result.score_total,
            guion.umbral,
            cuenta.ghl_native_task_workflow,
            label,
          );

          if (ghlResult.tag) tagsApplied++;
          if (ghlResult.tarea) tareasCreadas++;

          await drizzleDb
            .update(evaluacionesCoach)
            .set({ ghl_tag_applied: ghlResult.tag ? COACH_TAG : null })
            .where(
              and(
                eq(evaluacionesCoach.id_cuenta, cuenta.id_cuenta),
                eq(evaluacionesCoach.log_llamada_id, llamada.id),
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

  console.info(
    `[coachDrainer] Fin: evaluadas=${evaluadas} skip=${skipped} tags=${tagsApplied} tareas=${tareasCreadas} errores=${errors}`,
  );

  return {
    cuentas_procesadas: cuentasList.length,
    llamadas_evaluadas: evaluadas,
    llamadas_skip: skipped,
    tags_aplicados: tagsApplied,
    tareas_creadas: tareasCreadas,
    errores: errors,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveGuionForCall(
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

async function applyCoachTagAndTask(
  contactId: string,
  tokenGhl: string,
  locationId: string,
  idCuenta: number,
  notaAccionable: string,
  scoreTotal: number,
  umbral: number,
  ghlNativeTaskWorkflow: boolean,
  label: string,
): Promise<{ tag: boolean; tarea: boolean }> {
  let tagApplied = false;
  let tareaCreated = false;

  try {
    await createLocationTag(locationId, tokenGhl, COACH_TAG);
    await safeAddContactTags(contactId, tokenGhl, [COACH_TAG], locationId);
    tagApplied = true;
  } catch (err) {
    const isTokenInvalid = (err as Error & { isTokenInvalid?: boolean }).isTokenInvalid;
    if (isTokenInvalid) {
      await savePendingTag(idCuenta, contactId, COACH_TAG, "Token GHL inválido (coach)");
    } else {
      console.error(`${label} Error aplicando tag coach:`, err);
    }
  }

  if (!ghlNativeTaskWorkflow) {
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

  return { tag: tagApplied, tarea: tareaCreated };
}

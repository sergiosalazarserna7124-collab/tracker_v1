import { eq, and, inArray, sql, lt, isNotNull, isNull } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { agendas, cuentas, llamadas } from "../../db/schema.js";
import { addContactTag, addContactTags } from "../ghl-api.service.js";
import { processInChunks } from "../../utils/batch.utils.js";
import { withRetry } from "../../utils/retry.utils.js";
import { db as pgPool } from "../../config/database.js";
import { analyzeChatWithAI } from "../ai/chat-analysis.service.js";

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface UpdateNoShowsInput {
  target_date: string;
  account_ids: number[];
}

interface UpdateNoShowsResult {
  success: boolean;
  target_date: string;
  processed_count: number;
  updated_ids: number[];
  tagged_count: number;
  reglas_aplicadas?: number;
}

interface EmbudoEtapaMinimal {
  id: string;
  nombre: string;
  reglas_automaticas?: Array<{ evento: string; valor?: number }>;
}

// ─── Lógica principal ─────────────────────────────────────────────────────────

export async function updateNoShows(input: UpdateNoShowsInput): Promise<UpdateNoShowsResult> {
  const { target_date, account_ids } = input;

  // ── 1. Batch UPDATE con Drizzle ──────────────────────────────────────────────
  // Condiciones:
  //   - id_cuenta está en el array recibido
  //   - la fecha de la reunión (casteada a date) coincide con target_date
  //   - la categoría actual es PDTE (solo marcamos no-shows de citas pendientes)
  //   - NO tiene fathom_recording_id (si ya fue grabado por Fathom, NO es no-show)
  //     Fathom puede tardar 24-72h en procesar y enviar el webhook. Si ya tiene recording_id
  //     significa que la reunión SÍ ocurrió y el sistema ya lo procesó o lo procesará pronto.
  // Acciones:
  //   - categoria → 'no_show'
  //   - tags: concatena ',noshowautoia' (o lo pone como primer tag si está vacío)

  const updated = await withRetry(
    () =>
      drizzleDb
        .update(agendas)
        .set({
          categoria: "no_show",
          tags: sql<string>`
            CASE
              WHEN ${agendas.tags} IS NULL OR ${agendas.tags} = ''
              THEN 'noshowautoia'
              ELSE ${agendas.tags} || ',noshowautoia'
            END
          `,
        })
        .where(
          and(
            inArray(agendas.id_cuenta, account_ids),
            sql`CAST(${agendas.fechaReunion} AS date) = ${target_date}::date`,
            eq(agendas.categoria, "PDTE"),
            // Excluir registros que ya tienen grabación de Fathom — la reunión SÍ ocurrió
            isNull(agendas.fathom_recording_id),
          ),
        )
        .returning({
          id_registro_agenda: agendas.id_registro_agenda,
          id_cuenta: agendas.id_cuenta,
          ghl_contact_id: agendas.ghl_contact_id,
        }),
    { label: "updateNoShows/batchUpdate" },
  );

  if (updated.length === 0) {
    // Aun si no hay nuevos no-shows, aplicar reglas automáticas en las cuentas
    const reglasCount = await applyReglaAutomaticaAllAccounts(account_ids);
    return {
      success: true,
      target_date,
      processed_count: 0,
      updated_ids: [],
      tagged_count: 0,
      reglas_aplicadas: reglasCount,
    };
  }

  // ── 2. Obtener tokens GHL de las cuentas afectadas ───────────────────────────

  const uniqueAccountIds = [...new Set(updated.map((r) => r.id_cuenta))];

  const accountRows = await withRetry(
    () =>
      drizzleDb
        .select({ id_cuenta: cuentas.id_cuenta, token_ghl: cuentas.token_ghl })
        .from(cuentas)
        .where(inArray(cuentas.id_cuenta, uniqueAccountIds)),
    { label: "updateNoShows/getTokens" },
  );

  const tokenByAccount = new Map(
    accountRows
      .filter((a) => a.token_ghl !== null)
      .map((a) => [a.id_cuenta, a.token_ghl as string]),
  );

  // ── 3. Push tag 'noshowautoia' a GHL con rate limiting ───────────────────────
  // Procesa en lotes de 10 con 500ms de pausa entre lotes para respetar
  // el rate limit de GHL y evitar errores 429 Too Many Requests.
  // Los errores individuales se capturan para no abortar el batch completo.

  const contactsToTag = updated.filter(
    (r) => r.ghl_contact_id !== null && tokenByAccount.has(r.id_cuenta),
  );

  const tagResults = await processInChunks(
    contactsToTag,
    10,
    500,
    (r) =>
      addContactTag(r.ghl_contact_id as string, tokenByAccount.get(r.id_cuenta)!, "noshowautoia")
        .then(() => true)
        .catch((err: unknown) => {
          console.error(
            `[Cron no-show] Tag fallido contacto=${r.ghl_contact_id} cuenta=${r.id_cuenta}:`,
            err,
          );
          return false;
        }),
  );

  const tagged_count = tagResults.filter(Boolean).length;

  // ── 4. Aplicar reglas_automaticas del embudo personalizado ──────────────────
  const reglasCount = await applyReglaAutomaticaAllAccounts(account_ids);

  return {
    success: true,
    target_date,
    processed_count: updated.length,
    updated_ids: updated.map((r) => r.id_registro_agenda),
    tagged_count,
    reglas_aplicadas: reglasCount,
  };
}

// ─── Reglas automáticas del embudo ────────────────────────────────────────────

/**
 * Aplica reglas_automaticas definidas en el embudo personalizado de cada cuenta.
 * Para cada etapa con reglas, mueve los leads correspondientes a esa etapa.
 * Reglas soportadas:
 *   - no_show: leads con categoria='no_show' → mover a esta etapa
 *   - cancelada: leads con categoria='cancelada' → mover a esta etapa
 *   - sin_actividad_dias: leads cuya última actividad supera N días → mover a esta etapa
 */
async function applyReglaAutomaticaAllAccounts(account_ids: number[]): Promise<number> {
  if (account_ids.length === 0) return 0;

  let totalMoved = 0;

  // Obtener cuentas con su embudo personalizado
  const cuentaRows = await withRetry(
    () =>
      drizzleDb
        .select({
          id_cuenta: cuentas.id_cuenta,
          embudo_personalizado: cuentas.embudo_personalizado,
          token_ghl: cuentas.token_ghl,
          locationid: cuentas.locationid,
        })
        .from(cuentas)
        .where(inArray(cuentas.id_cuenta, account_ids)),
    { label: "applyReglas/getCuentas" },
  );

  for (const cuenta of cuentaRows) {
    const embudo = cuenta.embudo_personalizado as EmbudoEtapaMinimal[] | null;
    if (!Array.isArray(embudo) || embudo.length === 0) continue;

    try {
      const moved = await applyReglaAutomaticaForCuenta(
        cuenta.id_cuenta,
        embudo,
        cuenta.token_ghl,
        cuenta.locationid,
      );
      totalMoved += moved;
    } catch (err) {
      console.error(`[Cron reglas] Error procesando cuenta=${cuenta.id_cuenta}:`, err);
    }
  }

  return totalMoved;
}

async function applyReglaAutomaticaForCuenta(
  idCuenta: number,
  embudo: EmbudoEtapaMinimal[],
  _tokenGhl: string | null,
  _locationId: string | null,
): Promise<number> {
  let moved = 0;

  for (const etapa of embudo) {
    const reglas = etapa.reglas_automaticas ?? [];
    if (reglas.length === 0) continue;

    const etapaLabel = etapa.nombre ?? etapa.id;

    for (const regla of reglas) {
      try {
        if (regla.evento === "no_show" || regla.evento === "cancelada") {
          // Mover leads con esa categoria a esta etapa del embudo
          const result = await withRetry(
            () =>
              drizzleDb
                .update(agendas)
                .set({ categoria: etapaLabel })
                .where(
                  and(
                    eq(agendas.id_cuenta, idCuenta),
                    eq(agendas.categoria, regla.evento),
                  ),
                )
                .returning({ id: agendas.id_registro_agenda }),
            { label: `applyReglas/${regla.evento}/update` },
          );
          if (result.length > 0) {
            console.info(
              `[Cron reglas] cuenta=${idCuenta} evento=${regla.evento} → etapa="${etapaLabel}" (${result.length} agendas)`,
            );
            moved += result.length;
          }
        } else if (regla.evento === "sin_actividad_dias" && regla.valor && regla.valor > 0) {
          // Buscar leads en registros_de_llamada cuya última actividad supera N días
          // y moverlos a esta etapa
          const diasLimite = regla.valor;
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - diasLimite);

          const result = await withRetry(
            () =>
              drizzleDb
                .update(llamadas)
                .set({
                  estado: etapaLabel,
                })
                .where(
                  and(
                    eq(llamadas.id_cuenta, idCuenta),
                    lt(llamadas.fecha_y_hora_de_seguimiento, cutoffDate),
                    // Solo mover leads que estén en etapas activas (no cerradas)
                    sql`${llamadas.estado} NOT IN ('cerrado', 'ganado', 'perdido', ${etapaLabel})`,
                  ),
                )
                .returning({ id: llamadas.id_registro }),
            { label: `applyReglas/sin_actividad_dias/update` },
          );
          if (result.length > 0) {
            console.info(
              `[Cron reglas] cuenta=${idCuenta} sin_actividad_dias=${diasLimite} → etapa="${etapaLabel}" (${result.length} llamadas)`,
            );
            moved += result.length;
          }
        }
      } catch (err) {
        console.error(
          `[Cron reglas] Error en regla evento=${regla.evento} etapa="${etapaLabel}" cuenta=${idCuenta}:`,
          err,
        );
      }
    }
  }

  return moved;
}

// ─── Análisis nocturno de chats con IA ───────────────────────────────────────

interface ChatLogRow {
  id_evento: number;
  id_cuenta: number;
  chat: unknown;
  id_lead: string | null;
  nombre_lead: string | null;
}

interface CuentaAnalisisRow {
  id_cuenta: number;
  token_ghl: string | null;
  openai_api_key: string | null;
  embudo_personalizado: unknown;
  reglas_etiquetas: unknown;
  prompt_ventas: string | null;
}

interface AnalyzeChatsResult {
  processed: number;
  updated: number;
  errors: number;
  costEstimate: string;
}

// Cuentas sin key propia: máx 20/día para no quemar la key del servidor
// Cuentas con key propia: máx 50/día (ellos pagan su propio costo)
const MAX_CHATS_SERVER_KEY = 20;
const MAX_CHATS_OWN_KEY = 50;
const DELAY_MS = 200;
// Circuit breaker: detener procesamiento si llevamos más de este tiempo (en ms)
// Cloud Run timeout es 300s — paramos a los 240s para dejar 60s de margen
const MAX_RUNTIME_MS = 240_000;
// GPT-4o-mini pricing (input: $0.15/1M tokens, output: $0.60/1M tokens)
// Estimate ~500 tokens input + ~100 tokens output per chat
const COST_PER_CHAT_USD = (500 * 0.15 + 100 * 0.60) / 1_000_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function analyzeChatsNightly(accountIds?: number[]): Promise<AnalyzeChatsResult> {
  let processed = 0;
  let updated = 0;
  let errors = 0;
  const startTime = Date.now();

  // ── 1. Obtener cuentas activas con embudo configurado ─────────────────────
  const accountFilter = accountIds && accountIds.length > 0
    ? `AND c.id_cuenta = ANY($1::int[])`
    : "";

  const cuentasQuery = `
    SELECT c.id_cuenta, c.token_ghl, c.openai_api_key,
           c.embudo_personalizado, c.reglas_etiquetas, c.prompt_ventas
    FROM cuentas c
    WHERE c.embudo_personalizado IS NOT NULL
      AND jsonb_array_length(c.embudo_personalizado::jsonb) > 0
    ${accountFilter}
  `;

  const cuentasResult = await withRetry(
    () => pgPool.query<CuentaAnalisisRow>(
      cuentasQuery,
      accountIds && accountIds.length > 0 ? [accountIds] : [],
    ),
    { label: "analyzeChatsNightly/getCuentas" },
  );

  const cuentas = cuentasResult.rows;
  console.info(`[analyzeChats] ${cuentas.length} cuentas con embudo para analizar`);

  for (const cuenta of cuentas) {
    // Circuit breaker inter-cuenta: si ya superamos el tiempo máximo, no iniciar nueva cuenta
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      console.warn(
        `[analyzeChats] Circuit breaker activado. Omitiendo cuenta=${cuenta.id_cuenta} y siguientes. ` +
        `Tiempo transcurrido: ${Math.round((Date.now() - startTime) / 1000)}s`,
      );
      break;
    }

    // ── 2. Buscar chats sin ia_categoria de las últimas 24h ─────────────────
    const chatsResult = await withRetry(
      () => pgPool.query<ChatLogRow>(
        `SELECT id_evento, id_cuenta, chat, id_lead, nombre_lead
         FROM chats_logs
         WHERE id_cuenta = $1
           AND ia_categoria IS NULL
           AND fecha_y_hora_z >= NOW() - INTERVAL '24 hours'
         ORDER BY fecha_y_hora_z DESC
         LIMIT $2`,
        [cuenta.id_cuenta, cuenta.openai_api_key ? MAX_CHATS_OWN_KEY : MAX_CHATS_SERVER_KEY],
      ),
      { label: `analyzeChats/getChats/${cuenta.id_cuenta}` },
    );

    const chats = chatsResult.rows;
    if (chats.length === 0) continue;

    console.info(`[analyzeChats] cuenta=${cuenta.id_cuenta}: ${chats.length} chats a analizar`);

    const embudo = Array.isArray(cuenta.embudo_personalizado)
      ? (cuenta.embudo_personalizado as Array<{ id: string; nombre: string; condition?: string }>)
      : [];

    const reglas_etiquetas = Array.isArray(cuenta.reglas_etiquetas)
      ? (cuenta.reglas_etiquetas as Array<{ id: string; tag: string; condition: string; source: string }>)
      : [];

    for (const chat of chats) {
      // Circuit breaker: si llevamos más de MAX_RUNTIME_MS, detener para no exceder timeout de Cloud Run
      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        console.warn(
          `[analyzeChats] Circuit breaker activado tras ${Math.round((Date.now() - startTime) / 1000)}s. ` +
          `Chats restantes sin procesar en cuenta=${cuenta.id_cuenta}. Próxima ejecución del cron continuará.`,
        );
        break;
      }

      processed++;
      try {
        const messages = Array.isArray(chat.chat)
          ? (chat.chat as Array<{ role: string; message: string; timestamp: string; name?: string }>)
          : [];

        if (messages.length === 0) {
          // Marcar como analizado sin categoría
          await pgPool.query(
            `UPDATE chats_logs SET ia_categoria = 'sin_mensajes', ia_analizado_at = NOW() WHERE id_evento = $1`,
            [chat.id_evento],
          );
          continue;
        }

        // ── 3. Analizar con IA ──────────────────────────────────────────────
        const result = await analyzeChatWithAI({
          messages,
          embudo,
          reglas_etiquetas,
          prompt_empresa: cuenta.prompt_ventas ?? undefined,
          openai_api_key: cuenta.openai_api_key ?? undefined,
        });

        // ── 4. Actualizar chats_logs ────────────────────────────────────────
        await pgPool.query(
          `UPDATE chats_logs
           SET estado = COALESCE($1, estado),
               tags_internos = COALESCE($2::jsonb, tags_internos),
               ia_categoria = $3,
               ia_analizado_at = NOW()
           WHERE id_evento = $4`,
          [
            result.categoria,
            result.tags_internos.length > 0 ? JSON.stringify(result.tags_internos) : null,
            result.categoria ?? "analizado_sin_categoria",
            chat.id_evento,
          ],
        );

        // ── 5. Aplicar tags en GHL ──────────────────────────────────────────
        if (result.tags_internos.length > 0 && chat.id_lead && cuenta.token_ghl) {
          try {
            await addContactTags(chat.id_lead, cuenta.token_ghl, result.tags_internos);
          } catch (ghlErr) {
            console.warn(
              `[analyzeChats] GHL tag fallido lead=${chat.id_lead} cuenta=${cuenta.id_cuenta}:`,
              ghlErr,
            );
          }
        }

        updated++;
        console.info(
          `[analyzeChats] chat=${chat.id_evento} → categoria="${result.categoria}" tags=${result.tags_internos.join(",")} confianza=${result.confianza}`,
        );
      } catch (err) {
        errors++;
        console.error(`[analyzeChats] Error en chat=${chat.id_evento}:`, err);
        // Marcar como intentado para no reintentar indefinidamente
        await pgPool.query(
          `UPDATE chats_logs SET ia_categoria = 'error_analisis', ia_analizado_at = NOW() WHERE id_evento = $1`,
          [chat.id_evento],
        ).catch(() => {});
      }

      // ── 6. Rate limit: 200ms entre llamadas ─────────────────────────────
      await sleep(DELAY_MS);
    }
  }

  const costEstimate = `~$${(updated * COST_PER_CHAT_USD).toFixed(4)} USD (${updated} chats × $${COST_PER_CHAT_USD.toFixed(6)}/chat)`;

  console.info(`[analyzeChats] Finalizado: processed=${processed} updated=${updated} errors=${errors} costo=${costEstimate}`);

  return { processed, updated, errors, costEstimate };
}

// ─── expirePdteRegistros ──────────────────────────────────────────────────────

interface ExpirePdteResult {
  success: boolean;
  total_expirados: number;
  por_cuenta: Array<{ id_cuenta: number; expirados: number }>;
}

/**
 * Marca como 'no_contestado' todos los registros_de_llamada que lleven
 * más de 7 días en estado 'pdte' sin recibir un webhook de resolución.
 */
export async function expirePdteRegistros(): Promise<ExpirePdteResult> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const rows = await drizzleDb
    .update(llamadas)
    .set({ estado: "no_contestado" })
    .where(
      and(
        eq(llamadas.estado, "pdte"),
        isNotNull(llamadas.fecha_evento),
        lt(llamadas.fecha_evento, sevenDaysAgo),
      ),
    )
    .returning({ id_registro: llamadas.id_registro, id_cuenta: llamadas.id_cuenta });

  // Agrupa por id_cuenta para el log
  const countMap = new Map<number, number>();
  for (const row of rows) {
    const cuentaId = row.id_cuenta ?? 0;
    countMap.set(cuentaId, (countMap.get(cuentaId) ?? 0) + 1);
  }
  const por_cuenta = [...countMap.entries()]
    .map(([id_cuenta, expirados]) => ({ id_cuenta, expirados }))
    .sort((a, b) => b.expirados - a.expirados);

  console.info(
    `[expirePdteRegistros] total=${rows.length} por_cuenta=${JSON.stringify(por_cuenta)}`,
  );

  return { success: true, total_expirados: rows.length, por_cuenta };
}

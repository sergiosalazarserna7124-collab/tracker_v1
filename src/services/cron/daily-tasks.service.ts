import { eq, and, inArray, sql, lt, isNotNull, isNull } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { agendas, cuentas, llamadas } from "../../db/schema.js";
import { addContactTag, addContactTags, getContactAppointmentDate, getContactById, matchCategoriaPorEtiqueta, matchCategoriaLead, categoriasUsanEtiquetas } from "../ghl-api.service.js";
import { processInChunks } from "../../utils/batch.utils.js";
import { withRetry } from "../../utils/retry.utils.js";
import { db as pgPool } from "../../config/database.js";
import { analyzeChatWithAI } from "../ai/chat-analysis.service.js";
import { enrichWithGemini, resolveGeminiKey } from "../ai/gemini-enrichment.service.js";
import { parseCriteriosCalificacion } from "../data/criterios-calificacion.utils.js";

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
  //   - tags: concatena ',no_show_lm' (o lo pone como primer tag si está vacío)

  const updated = await withRetry(
    () =>
      drizzleDb
        .update(agendas)
        .set({
          categoria: "no_show",
          tags: sql<string>`
            CASE
              WHEN ${agendas.tags} IS NULL OR ${agendas.tags} = ''
              THEN 'no_show_lm'
              ELSE ${agendas.tags} || ',no_show_lm'
            END
          `,
        })
        .where(
          and(
            inArray(agendas.id_cuenta, account_ids),
            // Solo marcar no_show cuando fecha_reunion está explícita Y ya pasó (= target_date).
            // Si fecha_reunion es NULL no podemos saber si la reunión pasó → NO tocar.
            // Antes usábamos COALESCE(fecha_reunion, fecha) pero fecha es la fecha de creación
            // del registro, no de la reunión → marcaba como no_show citas que aún no ocurrían.
            isNotNull(agendas.fechaReunion),
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

  // ── 2. Fallback GHL para citas sin fecha_reunion explícita ───────────────────
  // Para cuentas tipo Fathom donde GHL no envía fecha_reunion en el webhook,
  // consultamos la API de GHL para obtener la fecha real del appointment del contacto.
  // Si la fecha ya pasó (= target_date) → marcar no_show.
  // Si no tiene appointment o la fecha es futura → dejar en PDTE.
  const targetDateObj = new Date(`${target_date}T12:00:00Z`);

  // Citas PDTE sin fecha_reunion que tienen ghl_contact_id
  const pdteSinFechaRows = await withRetry(
    () =>
      drizzleDb
        .select({
          id_registro_agenda: agendas.id_registro_agenda,
          id_cuenta: agendas.id_cuenta,
          ghl_contact_id: agendas.ghl_contact_id,
        })
        .from(agendas)
        .where(
          and(
            inArray(agendas.id_cuenta, account_ids),
            isNull(agendas.fechaReunion),
            isNotNull(agendas.ghl_contact_id),
            eq(agendas.categoria, "PDTE"),
            isNull(agendas.fathom_recording_id),
          ),
        )
        .limit(100), // limitar por seguridad — evitar flood a la API de GHL
    { label: "updateNoShows/pdteSinFecha" },
  );

  // Obtener tokens por cuenta para hacer las llamadas a GHL
  const accountIdsParaFallback = [...new Set([
    ...pdteSinFechaRows.map((r) => r.id_cuenta),
    ...(updated.length > 0 ? updated.map((r) => r.id_cuenta) : []),
  ])];

  const tokenRows = await withRetry(
    () =>
      drizzleDb
        .select({ id_cuenta: cuentas.id_cuenta, token_ghl: cuentas.token_ghl })
        .from(cuentas)
        .where(inArray(cuentas.id_cuenta, accountIdsParaFallback)),
    { label: "updateNoShows/tokensParaFallback" },
  );
  const tokenMapEarly = new Map(
    tokenRows.filter((r) => r.token_ghl).map((r) => [r.id_cuenta, r.token_ghl as string]),
  );

  const noShowsViaGhl: number[] = [];
  for (const row of pdteSinFechaRows) {
    const token = tokenMapEarly.get(row.id_cuenta);
    if (!token || !row.ghl_contact_id) continue;
    try {
      const apptDate = await getContactAppointmentDate(row.ghl_contact_id, token, targetDateObj);
      if (!apptDate) continue; // sin appointment en GHL → dejar en PDTE
      const apptDay = apptDate.toISOString().slice(0, 10);
      if (apptDay !== target_date) continue; // la reunión no era hoy → dejar en PDTE
      // La reunión era target_date y está en PDTE → marcar no_show
      await withRetry(
        () =>
          drizzleDb
            .update(agendas)
            .set({
              categoria: "no_show",
              fechaReunion: apptDate, // guardar la fecha obtenida de GHL para futuros checks
              tags: sql<string>`
                CASE
                  WHEN ${agendas.tags} IS NULL OR ${agendas.tags} = ''
                  THEN 'no_show_lm'
                  ELSE ${agendas.tags} || ',no_show_lm'
                END
              `,
            })
            .where(eq(agendas.id_registro_agenda, row.id_registro_agenda)),
        { label: "updateNoShows/markNoShowViaGhl" },
      );
      noShowsViaGhl.push(row.id_registro_agenda);
      console.info(`[NoShows/GHL] id=${row.id_registro_agenda} contactId=${row.ghl_contact_id} → no_show (fecha GHL: ${apptDay})`);
    } catch (err) {
      console.warn(`[NoShows/GHL] Error consultando appointment contactId=${row.ghl_contact_id}:`, err);
    }
  }

  if (updated.length === 0 && noShowsViaGhl.length === 0) {
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

  // ── 3. Obtener tokens GHL de las cuentas afectadas ───────────────────────────

  const uniqueAccountIds = [...new Set([...updated.map((r) => r.id_cuenta), ...noShowsViaGhl.map(() => 0).filter(Boolean)])];

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

  // ── 3. Push tag 'no_show_lm' a GHL con rate limiting ───────────────────────
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
      addContactTag(r.ghl_contact_id as string, tokenByAccount.get(r.id_cuenta)!, "no_show_lm")
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
  canales_activos: string[] | null;
  criterios_calificacion: unknown;
  gemini_api_key: string | null;
  gemini_premium_status: string | null;
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
           c.embudo_personalizado, c.reglas_etiquetas, c.prompt_ventas,
           c.canales_activos, c.criterios_calificacion, c.categorias_chats, c.categorias_leads,
           c.gemini_api_key, c.gemini_premium_status
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

  // ── 2. Pre-cargar chats pendientes de TODAS las cuentas ───────────────────
  // Estrategia round-robin: dar a cada cuenta un slot equitativo de tiempo,
  // independientemente del id_cuenta. Evita que cuentas con id alto queden
  // sin procesar cuando el circuit breaker corta el tiempo disponible.

  interface CuentaConChats {
    cuenta: CuentaAnalisisRow;
    chats: ChatLogRow[];
    embudo: Array<{ id: string; nombre: string; condition?: string; fuentes?: string[] }>;
    reglas_etiquetas: Array<{ id: string; tag: string; condition: string; source?: string; fuentes?: string[] }>;
    prompt_calificacion_chats: string | null;
  }

  const cuentasConChats: CuentaConChats[] = [];

  for (const cuenta of cuentas) {
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

    if (chatsResult.rows.length === 0) continue;

    console.info(`[analyzeChats] cuenta=${cuenta.id_cuenta}: ${chatsResult.rows.length} chats pendientes`);

    let promptCalificacionChats: string | null = null;
    try {
      const criterios = cuenta.criterios_calificacion
        ? parseCriteriosCalificacion(cuenta.criterios_calificacion)
        : null;
      promptCalificacionChats = criterios?.prompt_calificacion_chats ?? null;
    } catch {
      // criterios_calificacion malformado — ignorar
    }

    cuentasConChats.push({
      cuenta,
      chats: chatsResult.rows,
      embudo: Array.isArray(cuenta.embudo_personalizado)
        ? (cuenta.embudo_personalizado as Array<{ id: string; nombre: string; condition?: string; fuentes?: string[] }>)
        : [],
      reglas_etiquetas: Array.isArray(cuenta.reglas_etiquetas)
        ? (cuenta.reglas_etiquetas as Array<{ id: string; tag: string; condition: string; source?: string; fuentes?: string[] }>)
        : [],
      prompt_calificacion_chats: promptCalificacionChats,
    });
  }

  // ── 3. Procesar en round-robin ─────────────────────────────────────────────
  // En cada vuelta se toma el siguiente chat de cada cuenta (ronda 0 = primer
  // chat de todas, ronda 1 = segundo chat de todas, etc.). Si el circuit
  // breaker corta, todas las cuentas habrán tenido rondas equitativas.

  const maxChatsPerAccount = Math.max(
    ...cuentasConChats.map((c) => c.chats.length),
    0,
  );

  outer: for (let round = 0; round < maxChatsPerAccount; round++) {
    for (const { cuenta, chats, embudo, reglas_etiquetas, prompt_calificacion_chats } of cuentasConChats) {
      if (round >= chats.length) continue; // esta cuenta ya terminó sus chats

      // Circuit breaker: detener si superamos el tiempo máximo
      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        console.warn(
          `[analyzeChats] Circuit breaker activado tras ${Math.round((Date.now() - startTime) / 1000)}s ` +
          `(ronda ${round}). Todas las cuentas recibieron al menos ${round} chats procesados.`,
        );
        break outer;
      }

      const chat = chats[round];
      processed++;

      try {
        const messages = Array.isArray(chat.chat)
          ? (chat.chat as Array<{ role: string; message: string; timestamp: string; name?: string }>)
          : [];

        if (messages.length === 0) {
          await pgPool.query(
            `UPDATE chats_logs SET ia_categoria = 'sin_mensajes', ia_analizado_at = NOW() WHERE id_evento = $1`,
            [chat.id_evento],
          );
          continue;
        }

        // ── 3a. Analizar con IA ─────────────────────────────────────────────
        const embudoChat = embudo.filter((e) =>
          !e.fuentes || e.fuentes.length === 0 || e.fuentes.some((f) => ["chat", "chats", "todas"].includes(f)),
        );
        // Etapa del LEAD / categoría de chat por etiqueta del contacto
        let promptChatPorEtiqueta: string | null = null;
        let reglasChatEfectivas: unknown = reglas_etiquetas;
        const cuentaCats = cuenta as { categorias_chats?: unknown; categorias_leads?: unknown };
        if (chat.id_lead && cuenta.token_ghl &&
            (categoriasUsanEtiquetas(cuentaCats.categorias_leads) || categoriasUsanEtiquetas(cuentaCats.categorias_chats))) {
          try {
            const ct = await getContactById(chat.id_lead, cuenta.token_ghl);
            const leadCat = matchCategoriaLead(ct?.tags, cuentaCats.categorias_leads);
            if (leadCat) {
              if (leadCat.prompt?.trim()) promptChatPorEtiqueta = leadCat.prompt.trim();
              if (Array.isArray(leadCat.reglas_etiquetas) && leadCat.reglas_etiquetas.length > 0) {
                reglasChatEfectivas = leadCat.reglas_etiquetas;
              }
            }
            if (!promptChatPorEtiqueta) {
              const match = matchCategoriaPorEtiqueta(ct?.tags, cuentaCats.categorias_chats);
              if (match?.prompt?.trim()) promptChatPorEtiqueta = match.prompt.trim();
            }
          } catch { /* best-effort */ }
        }

        const result = await analyzeChatWithAI({
          messages,
          embudo: embudoChat,
          reglas_etiquetas: reglasChatEfectivas as typeof reglas_etiquetas,
          prompt_empresa: cuenta.prompt_ventas ?? undefined,
          openai_api_key: cuenta.openai_api_key ?? undefined,
          id_cuenta: cuenta.id_cuenta,
          canales_activos: Array.isArray(cuenta.canales_activos) ? cuenta.canales_activos : null,
          prompt_calificacion_chats: promptChatPorEtiqueta ?? prompt_calificacion_chats,
        });

        // ── 3b. Actualizar chats_logs ───────────────────────────────────────
        await pgPool.query(
          `UPDATE chats_logs
           SET estado = COALESCE($1, estado),
               tags_internos = COALESCE($2::jsonb, tags_internos),
               ia_categoria = $3,
               ia_analizado_at = NOW(),
               ia_objeciones = COALESCE($5::jsonb, ia_objeciones)
           WHERE id_evento = $4`,
          [
            result.categoria,
            result.tags_internos.length > 0 ? JSON.stringify(result.tags_internos) : null,
            result.categoria ?? "analizado_sin_categoria",
            chat.id_evento,
            result.objeciones.length > 0
              ? JSON.stringify({ objeciones: result.objeciones, sentimiento: "neutro", senales_compra: [] })
              : null,
          ],
        );

        // ── 3c. Enriquecimiento Gemini (AUT-1301) ─────────────────────────
        const chatText = messages
          .map((m) => `${m.role === "lead" ? "Lead" : "Asesor"}: ${m.message}`)
          .join("\n");
        if (chatText.length >= 50) {
          const tenantGeminiKey = resolveGeminiKey(cuenta);
          const gemini = await enrichWithGemini(chatText, "chat", cuenta.id_cuenta, tenantGeminiKey).catch(() => null);
          if (gemini) {
            await pgPool.query(
              `UPDATE chats_logs SET gemini_enriquecimiento = $1::jsonb WHERE id_evento = $2`,
              [JSON.stringify(gemini), chat.id_evento],
            ).catch((e: unknown) => console.error(`[analyzeChats] Gemini update failed chat=${chat.id_evento}:`, e));
          }
        }

        // ── 3d. Aplicar tags en GHL ─────────────────────────────────────────
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
          `[analyzeChats] chat=${chat.id_evento} cuenta=${cuenta.id_cuenta} ronda=${round} → ` +
          `categoria="${result.categoria}" tags=${result.tags_internos.join(",")} confianza=${result.confianza}`,
        );
      } catch (err) {
        errors++;
        console.error(`[analyzeChats] Error en chat=${chat.id_evento} cuenta=${cuenta.id_cuenta}:`, err);
        await pgPool.query(
          `UPDATE chats_logs SET ia_categoria = 'error_analisis', ia_analizado_at = NOW() WHERE id_evento = $1`,
          [chat.id_evento],
        ).catch(() => {});
      }

      // ── Rate limit: 200ms entre llamadas ───────────────────────────────────
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

// ─── backfillPrimerMsgLeadAt ──────────────────────────────────────────────────

interface BackfillPrimerMsgResult {
  success: boolean;
  actualizados: number;
  sin_mensajes_lead: number;
}

/**
 * Backfill diario de primer_msg_lead_at en chats_logs.
 *
 * Para cada fila con primer_msg_lead_at NULL, calcula el timestamp del primer
 * mensaje de role="lead" dentro del JSONB chat[].
 *
 * Cuentas CON chatbot_transfer_marker: usa el primer mensaje lead DESPUÉS del
 * mensaje de transferencia chatbot→humano. Si el marker no está en el chat,
 * cae al primer mensaje lead absoluto (fallback seguro).
 *
 * Cuentas SIN chatbot_transfer_marker: comportamiento original (primer mensaje
 * lead absoluto).
 *
 * Operación idempotente: solo escribe en filas con valor NULL.
 *
 * Ejecutar una vez al día como safety net para cubrir cualquier webhook
 * que llegue sin dateAdded o que sea insertado por fuentes externas (n8n, etc.).
 */
export async function backfillPrimerMsgLeadAt(): Promise<BackfillPrimerMsgResult> {
  // ── 1. Cuentas CON chatbot_transfer_marker ─────────────────────────────────
  // Primer mensaje lead DESPUÉS del marker de transferencia.
  // Si el marker no aparece en el chat → cae al primer lead absoluto (COALESCE -1).
  const chatbotResult = await pgPool.query<{ id_evento: number }>(
    `UPDATE chats_logs cl
     SET primer_msg_lead_at = (
       WITH transfer_pos AS (
         SELECT (t.ordinality - 1)::int AS pos
         FROM jsonb_array_elements(cl.chat) WITH ORDINALITY AS t(msg, ordinality)
         WHERE t.msg->>'message' LIKE '%' || c.chatbot_transfer_marker || '%'
         ORDER BY t.ordinality
         LIMIT 1
       )
       SELECT MIN((t.msg->>'timestamp')::timestamptz)
       FROM jsonb_array_elements(cl.chat) WITH ORDINALITY AS t(msg, ordinality)
       WHERE t.msg->>'role' = 'lead'
         AND t.msg->>'timestamp' IS NOT NULL
         AND (t.ordinality - 1)::int > COALESCE((SELECT pos FROM transfer_pos), -1)
     )
     FROM cuentas c
     WHERE cl.id_cuenta = c.id_cuenta
       AND c.chatbot_transfer_marker IS NOT NULL
       AND c.chatbot_transfer_marker <> ''
       AND cl.primer_msg_lead_at IS NULL
       AND cl.chat IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(cl.chat) m
         WHERE m->>'role' = 'lead'
           AND m->>'timestamp' IS NOT NULL
       )
     RETURNING cl.id_evento`,
  );
  const actualizadosChatbot = chatbotResult.rowCount ?? 0;

  // ── 2. Cuentas SIN chatbot_transfer_marker (lógica original) ──────────────
  const standardResult = await pgPool.query<{ id_evento: number }>(
    `UPDATE chats_logs cl
     SET primer_msg_lead_at = (
       SELECT MIN((m->>'timestamp')::timestamptz)
       FROM jsonb_array_elements(cl.chat) m
       WHERE m->>'role' = 'lead'
         AND m->>'timestamp' IS NOT NULL
     )
     FROM cuentas c
     WHERE cl.id_cuenta = c.id_cuenta
       AND (c.chatbot_transfer_marker IS NULL OR c.chatbot_transfer_marker = '')
       AND cl.primer_msg_lead_at IS NULL
       AND cl.chat IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(cl.chat) m
         WHERE m->>'role' = 'lead'
           AND m->>'timestamp' IS NOT NULL
       )
     RETURNING cl.id_evento`,
  );
  const actualizadosStandard = standardResult.rowCount ?? 0;

  const actualizados = actualizadosChatbot + actualizadosStandard;

  // Contar filas que aún quedan NULL (sin mensajes lead — correcto por diseño)
  const pendingResult = await pgPool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM chats_logs WHERE primer_msg_lead_at IS NULL`,
  );
  const sin_mensajes_lead = parseInt(pendingResult.rows[0]?.count ?? "0", 10);

  console.info(
    `[backfillPrimerMsgLeadAt] actualizados=${actualizados} ` +
    `(chatbot=${actualizadosChatbot} standard=${actualizadosStandard}) | ` +
    `sin_mensajes_lead=${sin_mensajes_lead}`,
  );

  return { success: true, actualizados, sin_mensajes_lead };
}

// ─── backfillBotDelegacionAt (AUT-1762) ──────────────────────────────────────

interface BackfillBotDelegacionResult {
  success: boolean;
  actualizados: number;
}

export async function backfillBotDelegacionAt(): Promise<BackfillBotDelegacionResult> {
  const result = await pgPool.query<{ id_evento: number }>(
    `UPDATE chats_logs cl
     SET bot_delegacion_at = (
       SELECT MIN((t.msg->>'timestamp')::timestamptz)
       FROM jsonb_array_elements(cl.chat) WITH ORDINALITY AS t(msg, ordinality)
       WHERE t.msg->>'message' LIKE '%' || c.chatbot_transfer_marker || '%'
         AND t.msg->>'timestamp' IS NOT NULL
     )
     FROM cuentas c
     WHERE cl.id_cuenta = c.id_cuenta
       AND c.chatbot_transfer_marker IS NOT NULL
       AND c.chatbot_transfer_marker <> ''
       AND cl.bot_delegacion_at IS NULL
       AND cl.chat IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(cl.chat) m
         WHERE m->>'message' LIKE '%' || c.chatbot_transfer_marker || '%'
           AND m->>'timestamp' IS NOT NULL
       )
     RETURNING cl.id_evento`,
  );
  const actualizados = result.rowCount ?? 0;
  console.info(`[backfillBotDelegacionAt] actualizados=${actualizados}`);
  return { success: true, actualizados };
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

// ─── backfillPrimerMsgAt ─────────────────────────────────────────────────────

interface BackfillPrimerMsgAtResult {
  success: boolean;
  actualizados_jsonb: number;
  actualizados_fallback: number;
  pendientes_null: number;
}

/**
 * Safety net: rellena primer_msg_at desde el JSONB chat para filas que
 * fueron insertadas por writers que no conocen esta columna (AUT-690).
 *
 * Complementa el trigger fn_auto_primer_msg_at (migración 016) que cubre
 * INSERT/UPDATE en tiempo real. Este cron atrapa edge cases.
 */
export async function backfillPrimerMsgAt(): Promise<BackfillPrimerMsgAtResult> {
  const jsonbResult = await pgPool.query<{ id_evento: number }>(
    `UPDATE chats_logs
     SET primer_msg_at = (
       SELECT MIN((msg->>'timestamp')::timestamptz)
       FROM jsonb_array_elements(chat) AS msg
       WHERE msg->>'timestamp' IS NOT NULL
         AND msg->>'timestamp' <> ''
         AND (msg->>'timestamp')::timestamptz > '2020-01-01'::timestamptz
     )
     WHERE primer_msg_at IS NULL
       AND chat IS NOT NULL
       AND jsonb_array_length(chat) > 0
     RETURNING id_evento`,
  );
  const actualizados_jsonb = jsonbResult.rowCount ?? 0;

  const fallbackResult = await pgPool.query<{ id_evento: number }>(
    `UPDATE chats_logs
     SET primer_msg_at = COALESCE(primer_msg_lead_at, fecha_y_hora_z)
     WHERE primer_msg_at IS NULL
     RETURNING id_evento`,
  );
  const actualizados_fallback = fallbackResult.rowCount ?? 0;

  const pendingResult = await pgPool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM chats_logs WHERE primer_msg_at IS NULL`,
  );
  const pendientes_null = parseInt(pendingResult.rows[0]?.count ?? "0", 10);

  console.info(
    `[backfillPrimerMsgAt] jsonb=${actualizados_jsonb} fallback=${actualizados_fallback} | pendientes_null=${pendientes_null}`,
  );

  return { success: true, actualizados_jsonb, actualizados_fallback, pendientes_null };
}

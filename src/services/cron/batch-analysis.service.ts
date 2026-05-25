import { db as pgPool } from "../../config/database.js";
import { withRetry } from "../../utils/retry.utils.js";
import { analyzeChatBatch, analyzeLlamadaBatch } from "../ai/batch-conversation-analysis.service.js";

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface CuentaBatchRow {
  id_cuenta: number;
  openai_api_key: string | null;
  embudo_personalizado: unknown;
  prompt_ventas: string | null;
  prompt_llamadas: string | null;
}

interface ChatPendienteRow {
  id_evento: number;
  id_cuenta: number;
  chat: unknown;
  ia_categoria: string | null;
}

interface LlamadaPendienteRow {
  id: number;
  id_cuenta: number;
  transcripcion: string;
}

export interface BatchAnalysisResult {
  chats_procesados: number;
  chats_actualizados: number;
  llamadas_procesadas: number;
  llamadas_actualizadas: number;
  errores: number;
  llamadas_api: number;
}

// ─── Constantes ───────────────────────────────────────────────────────────────

// Max API calls por ejecución (entre chats + llamadas)
const MAX_API_CALLS = 100;
// Chats por cuenta por ejecución (sin key propia)
const MAX_CHATS_SERVER_KEY = 10;
// Chats por cuenta por ejecución (con key propia)
const MAX_CHATS_OWN_KEY = 25;
// Llamadas por cuenta por ejecución (sin key propia)
const MAX_LLAMADAS_SERVER_KEY = 5;
// Llamadas por cuenta por ejecución (con key propia)
const MAX_LLAMADAS_OWN_KEY = 10;
// Delay entre batches de 20 conversaciones (ms)
const BATCH_DELAY_MS = 1000;
const BATCH_SIZE = 20;
// Circuit breaker: 240s (Cloud Run timeout 300s - 60s margen)
const MAX_RUNTIME_MS = 240_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Función principal ────────────────────────────────────────────────────────

export async function runBatchAnalysis(accountIds?: number[]): Promise<BatchAnalysisResult> {
  let chatsProcessed = 0;
  let chatsUpdated = 0;
  let llamadasProcessed = 0;
  let llamadasUpdated = 0;
  let errors = 0;
  let apiCalls = 0;
  const startTime = Date.now();

  // ── 1. Obtener cuentas activas ────────────────────────────────────────────

  const accountFilter = accountIds && accountIds.length > 0
    ? `AND c.id_cuenta = ANY($1::int[])`
    : "";

  const cuentasResult = await withRetry(
    () => pgPool.query<CuentaBatchRow>(
      `SELECT c.id_cuenta, c.openai_api_key, c.embudo_personalizado,
              c.prompt_ventas, c.prompt_llamadas
       FROM cuentas c
       WHERE (c.estado_cuenta NOT IN ('cancelado', 'inactivo') OR c.estado_cuenta IS NULL)
       ${accountFilter}
       ORDER BY c.id_cuenta`,
      accountIds && accountIds.length > 0 ? [accountIds] : [],
    ),
    { label: "batchAnalysis/getCuentas" },
  );

  const cuentasList = cuentasResult.rows;
  console.info(`[batchAnalysis] ${cuentasList.length} cuentas para procesar`);

  // ── 2. Pre-cargar pendientes de todas las cuentas ────────────────────────

  interface CuentaConPendientes {
    cuenta: CuentaBatchRow;
    chats: ChatPendienteRow[];
    llamadas: LlamadaPendienteRow[];
    embudo: Array<{ id: string; nombre: string }>;
  }

  const cuentasConPendientes: CuentaConPendientes[] = [];

  for (const cuenta of cuentasList) {
    const hasOwnKey = Boolean(cuenta.openai_api_key);
    const maxChats = hasOwnKey ? MAX_CHATS_OWN_KEY : MAX_CHATS_SERVER_KEY;
    const maxLlamadas = hasOwnKey ? MAX_LLAMADAS_OWN_KEY : MAX_LLAMADAS_SERVER_KEY;

    const [chatsResult, llamadasResult] = await Promise.all([
      withRetry(
        () => pgPool.query<ChatPendienteRow>(
          `SELECT id_evento, id_cuenta, chat, ia_categoria
           FROM chats_logs
           WHERE id_cuenta = $1
             AND ia_objeciones IS NULL
             AND chat IS NOT NULL
             AND jsonb_array_length(chat::jsonb) > 0
             AND fecha_y_hora_z >= NOW() - INTERVAL '48 hours'
           ORDER BY fecha_y_hora_z DESC
           LIMIT $2`,
          [cuenta.id_cuenta, maxChats],
        ),
        { label: `batchAnalysis/getChats/${cuenta.id_cuenta}` },
      ),
      withRetry(
        () => pgPool.query<LlamadaPendienteRow>(
          `SELECT id, id_cuenta, transcripcion
           FROM log_llamadas
           WHERE id_cuenta = $1
             AND ia_descripcion IS NULL
             AND transcripcion IS NOT NULL
             AND transcripcion <> ''
             AND ts >= NOW() - INTERVAL '48 hours'
           ORDER BY ts DESC
           LIMIT $2`,
          [cuenta.id_cuenta, maxLlamadas],
        ),
        { label: `batchAnalysis/getLlamadas/${cuenta.id_cuenta}` },
      ),
    ]);

    if (chatsResult.rows.length === 0 && llamadasResult.rows.length === 0) continue;

    const embudo = Array.isArray(cuenta.embudo_personalizado)
      ? (cuenta.embudo_personalizado as Array<{ id: string; nombre: string }>)
      : [];

    cuentasConPendientes.push({
      cuenta,
      chats: chatsResult.rows,
      llamadas: llamadasResult.rows,
      embudo,
    });

    console.info(
      `[batchAnalysis] cuenta=${cuenta.id_cuenta}: ` +
      `${chatsResult.rows.length} chats + ${llamadasResult.rows.length} llamadas pendientes`,
    );
  }

  // ── 3. Procesar en round-robin por batches ────────────────────────────────
  // Interleave chats y llamadas de todas las cuentas para distribuir equitativamente.
  // Pausa de 1s cada BATCH_SIZE llamadas a la API.

  // Construir lista plana de tareas (chats primero, luego llamadas)
  const chatTareas: Array<{ chat: ChatPendienteRow; item: CuentaConPendientes }> = [];
  const llamadaTareas: Array<{ llamada: LlamadaPendienteRow; item: CuentaConPendientes }> = [];

  // Round-robin entre cuentas
  const maxRounds = Math.max(...cuentasConPendientes.map((c) => Math.max(c.chats.length, c.llamadas.length)), 0);
  for (let round = 0; round < maxRounds; round++) {
    for (const item of cuentasConPendientes) {
      if (round < item.chats.length) chatTareas.push({ chat: item.chats[round], item });
      if (round < item.llamadas.length) llamadaTareas.push({ llamada: item.llamadas[round], item });
    }
  }

  // Procesar chats
  for (const { chat, item } of chatTareas) {
    if (apiCalls >= MAX_API_CALLS) {
      console.warn(`[batchAnalysis] Límite de ${MAX_API_CALLS} API calls alcanzado. Deteniendo.`);
      break;
    }
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      console.warn(`[batchAnalysis] Circuit breaker activado tras ${Math.round((Date.now() - startTime) / 1000)}s`);
      break;
    }

    chatsProcessed++;
    apiCalls++;

    try {
      const messages = Array.isArray(chat.chat)
        ? (chat.chat as Array<{ role: string; message: string; timestamp?: string; name?: string }>)
        : [];

      if (messages.length === 0) {
        await pgPool.query(
          `UPDATE chats_logs SET ia_objeciones = '{"objeciones":[],"sentimiento":"neutro","senales_compra":[]}'::jsonb WHERE id_evento = $1`,
          [chat.id_evento],
        );
        chatsUpdated++;
        continue;
      }

      const result = await analyzeChatBatch({
        messages,
        embudo: item.embudo,
        prompt_empresa: item.cuenta.prompt_ventas,
        openai_api_key: item.cuenta.openai_api_key,
        id_cuenta: item.cuenta.id_cuenta,
      });

      // Actualizar: ia_objeciones siempre; ia_categoria solo si aún es null
      await pgPool.query(
        `UPDATE chats_logs
         SET ia_objeciones = $1::jsonb,
             ia_categoria  = COALESCE(ia_categoria, $2),
             ia_analizado_at = COALESCE(ia_analizado_at, NOW())
         WHERE id_evento = $3`,
        [
          JSON.stringify(result.ia_objeciones),
          result.categoria,
          chat.id_evento,
        ],
      );

      chatsUpdated++;
      console.info(
        `[batchAnalysis] chat=${chat.id_evento} cuenta=${item.cuenta.id_cuenta} ` +
        `sentimiento=${result.ia_objeciones.sentimiento} objeciones=${result.ia_objeciones.objeciones.length}`,
      );
    } catch (err) {
      errors++;
      console.error(
        `[batchAnalysis] Error en chat=${chat.id_evento} cuenta=${item.cuenta.id_cuenta}:`,
        err,
      );
    }

    // Pausa de 1s cada BATCH_SIZE llamadas
    if (apiCalls % BATCH_SIZE === 0) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // Procesar llamadas
  for (const { llamada, item } of llamadaTareas) {
    if (apiCalls >= MAX_API_CALLS) {
      console.warn(`[batchAnalysis] Límite de ${MAX_API_CALLS} API calls alcanzado. Deteniendo.`);
      break;
    }
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      console.warn(`[batchAnalysis] Circuit breaker activado tras ${Math.round((Date.now() - startTime) / 1000)}s`);
      break;
    }

    llamadasProcessed++;
    // analyzeLlamadaBatch hace 2 llamadas a la API (structured + text) en paralelo
    apiCalls += 2;

    try {
      const result = await analyzeLlamadaBatch({
        transcripcion: llamada.transcripcion,
        prompt_ventas: item.cuenta.prompt_ventas,
        prompt_llamadas: item.cuenta.prompt_llamadas,
        openai_api_key: item.cuenta.openai_api_key,
        id_cuenta: item.cuenta.id_cuenta,
      });

      if (!result) {
        console.warn(`[batchAnalysis] llamada=${llamada.id} sin resultado (transcripción vacía)`);
        continue;
      }

      await pgPool.query(
        `UPDATE log_llamadas
         SET ia_descripcion = $1
         WHERE id = $2`,
        [result.ia_descripcion, llamada.id],
      );

      llamadasUpdated++;
      console.info(
        `[batchAnalysis] llamada=${llamada.id} cuenta=${item.cuenta.id_cuenta} ` +
        `sentimiento=${result.sentimiento} objeciones=${result.objeciones.length}`,
      );
    } catch (err) {
      errors++;
      console.error(
        `[batchAnalysis] Error en llamada=${llamada.id} cuenta=${item.cuenta.id_cuenta}:`,
        err,
      );
    }

    // Pausa de 1s cada BATCH_SIZE llamadas
    if (apiCalls % BATCH_SIZE === 0) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  console.info(
    `[batchAnalysis] Finalizado: chats=${chatsUpdated}/${chatsProcessed} ` +
    `llamadas=${llamadasUpdated}/${llamadasProcessed} errores=${errors} api_calls=${apiCalls}`,
  );

  return {
    chats_procesados: chatsProcessed,
    chats_actualizados: chatsUpdated,
    llamadas_procesadas: llamadasProcessed,
    llamadas_actualizadas: llamadasUpdated,
    errores: errors,
    llamadas_api: apiCalls,
  };
}

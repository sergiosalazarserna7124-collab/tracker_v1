import { db as pgPool } from "../../config/database.js";
import { enrichWithGemini, resolveGeminiKey, GeminiKeyError } from "../ai/gemini-enrichment.service.js";

const MAX_RUNTIME_MS = 210_000;
const DELAY_MS = 100;
const MAX_GEMINI_ATTEMPTS = 3;
const DEFAULT_CAP = 200;
const GEMINI_FLASH_INPUT_COST_PER_MILLION = 0.15;
const GEMINI_FLASH_OUTPUT_COST_PER_MILLION = 0.60;
const AVG_INPUT_TOKENS_PER_CONV = 600;
const AVG_OUTPUT_TOKENS_PER_CONV = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ByokBackfillEstimate {
  id_cuenta: number;
  nombre_cuenta: string | null;
  llamadas_pendientes: number;
  agendas_pendientes: number;
  chats_pendientes: number;
  total_pendientes: number;
  cap_per_table: number;
  total_a_procesar: number;
  costo_estimado_usd: string;
  tokens_estimados: number;
}

export interface ByokBackfillRunResult {
  id_cuenta: number;
  estimate: ByokBackfillEstimate;
  llamadas: { procesados: number; enriquecidos: number; errores: number };
  agendas: { procesados: number; enriquecidos: number; errores: number };
  chats: { procesados: number; enriquecidos: number; errores: number };
  total_enriquecidos: number;
  circuit_breaker: boolean;
  key_error: string | null;
}

async function countCandidates(
  idCuenta: number,
): Promise<{ llamadas: number; agendas: number; chats: number }> {
  const [llamadasRes, agendasRes, chatsRes] = await Promise.all([
    pgPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM log_llamadas
       WHERE id_cuenta = $1
         AND gemini_enriquecimiento IS NULL
         AND COALESCE(gemini_intentos, 0) < $2
         AND transcripcion IS NOT NULL
         AND LENGTH(transcripcion) >= 50`,
      [idCuenta, MAX_GEMINI_ATTEMPTS],
    ),
    pgPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM resumenes_diarios_agendas
       WHERE id_cuenta = $1
         AND gemini_enriquecimiento IS NULL
         AND COALESCE(gemini_intentos, 0) < $2
         AND (transcripcion_fathom IS NOT NULL OR resumen_ia IS NOT NULL)
         AND LENGTH(COALESCE(transcripcion_fathom, resumen_ia, '')) >= 50`,
      [idCuenta, MAX_GEMINI_ATTEMPTS],
    ),
    pgPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM chats_logs
       WHERE id_cuenta = $1
         AND gemini_enriquecimiento IS NULL
         AND COALESCE(gemini_intentos, 0) < $2
         AND chat IS NOT NULL
         AND jsonb_array_length(chat) > 0`,
      [idCuenta, MAX_GEMINI_ATTEMPTS],
    ),
  ]);

  return {
    llamadas: parseInt(llamadasRes.rows[0]?.count ?? "0", 10),
    agendas: parseInt(agendasRes.rows[0]?.count ?? "0", 10),
    chats: parseInt(chatsRes.rows[0]?.count ?? "0", 10),
  };
}

export async function estimateByokBackfill(idCuenta: number): Promise<ByokBackfillEstimate> {
  const cuentaRes = await pgPool.query<{
    nombre_cuenta: string | null;
    gemini_backfill_cap: number | null;
  }>(
    `SELECT nombre_cuenta, gemini_backfill_cap FROM cuentas WHERE id_cuenta = $1`,
    [idCuenta],
  );
  const cuenta = cuentaRes.rows[0];
  if (!cuenta) throw new Error(`Cuenta ${idCuenta} no encontrada`);

  const cap = cuenta.gemini_backfill_cap ?? DEFAULT_CAP;
  const candidates = await countCandidates(idCuenta);
  const total = candidates.llamadas + candidates.agendas + candidates.chats;
  const totalAProcesar = Math.min(candidates.llamadas, cap)
    + Math.min(candidates.agendas, cap)
    + Math.min(candidates.chats, cap);

  const tokensEstimados = totalAProcesar * (AVG_INPUT_TOKENS_PER_CONV + AVG_OUTPUT_TOKENS_PER_CONV);
  const costoInput = (totalAProcesar * AVG_INPUT_TOKENS_PER_CONV * GEMINI_FLASH_INPUT_COST_PER_MILLION) / 1_000_000;
  const costoOutput = (totalAProcesar * AVG_OUTPUT_TOKENS_PER_CONV * GEMINI_FLASH_OUTPUT_COST_PER_MILLION) / 1_000_000;
  const costoTotal = costoInput + costoOutput;

  return {
    id_cuenta: idCuenta,
    nombre_cuenta: cuenta.nombre_cuenta,
    llamadas_pendientes: candidates.llamadas,
    agendas_pendientes: candidates.agendas,
    chats_pendientes: candidates.chats,
    total_pendientes: total,
    cap_per_table: cap,
    total_a_procesar: totalAProcesar,
    costo_estimado_usd: `$${costoTotal.toFixed(4)}`,
    tokens_estimados: tokensEstimados,
  };
}

async function backfillTable(
  table: "log_llamadas" | "resumenes_diarios_agendas" | "chats_logs",
  idCuenta: number,
  apiKey: string,
  cap: number,
  startTime: number,
): Promise<{ procesados: number; enriquecidos: number; errores: number; circuit_breaker: boolean; key_error: string | null }> {
  let procesados = 0;
  let enriquecidos = 0;
  let errores = 0;

  if (table === "log_llamadas") {
    const { rows } = await pgPool.query<{ id: number; transcripcion: string }>(
      `SELECT id, transcripcion FROM log_llamadas
       WHERE id_cuenta = $1
         AND gemini_enriquecimiento IS NULL
         AND COALESCE(gemini_intentos, 0) < $2
         AND transcripcion IS NOT NULL
         AND LENGTH(transcripcion) >= 50
       ORDER BY ts DESC LIMIT $3`,
      [idCuenta, MAX_GEMINI_ATTEMPTS, cap],
    );

    for (const row of rows) {
      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        return { procesados, enriquecidos, errores, circuit_breaker: true, key_error: null };
      }
      procesados++;
      try {
        const result = await enrichWithGemini(row.transcripcion, "llamada", idCuenta, apiKey);
        if (result) {
          await pgPool.query(
            `UPDATE log_llamadas SET gemini_enriquecimiento = $1::jsonb WHERE id = $2`,
            [JSON.stringify(result), row.id],
          );
          enriquecidos++;
        } else {
          await pgPool.query(
            `UPDATE log_llamadas SET gemini_intentos = COALESCE(gemini_intentos, 0) + 1 WHERE id = $1`,
            [row.id],
          );
        }
      } catch (err) {
        if (err instanceof GeminiKeyError) {
          return { procesados, enriquecidos, errores, circuit_breaker: false, key_error: err.kind };
        }
        await pgPool.query(
          `UPDATE log_llamadas SET gemini_intentos = COALESCE(gemini_intentos, 0) + 1 WHERE id = $1`,
          [row.id],
        ).catch(() => {});
        errores++;
        console.error(`[byok-backfill] log_llamadas id=${row.id}:`, err);
      }
      await sleep(DELAY_MS);
    }
  } else if (table === "resumenes_diarios_agendas") {
    const { rows } = await pgPool.query<{
      id_registro_agenda: number;
      transcripcion_fathom: string;
      resumen_ia: string;
    }>(
      `SELECT id_registro_agenda,
              COALESCE(transcripcion_fathom, resumen_ia) AS transcripcion_fathom,
              resumen_ia
       FROM resumenes_diarios_agendas
       WHERE id_cuenta = $1
         AND gemini_enriquecimiento IS NULL
         AND COALESCE(gemini_intentos, 0) < $2
         AND (transcripcion_fathom IS NOT NULL OR resumen_ia IS NOT NULL)
         AND LENGTH(COALESCE(transcripcion_fathom, resumen_ia, '')) >= 50
       ORDER BY fecha DESC LIMIT $3`,
      [idCuenta, MAX_GEMINI_ATTEMPTS, cap],
    );

    for (const row of rows) {
      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        return { procesados, enriquecidos, errores, circuit_breaker: true, key_error: null };
      }
      procesados++;
      const text = row.transcripcion_fathom || row.resumen_ia;
      try {
        const result = await enrichWithGemini(text, "videollamada", idCuenta, apiKey);
        if (result) {
          await pgPool.query(
            `UPDATE resumenes_diarios_agendas SET gemini_enriquecimiento = $1::jsonb WHERE id_registro_agenda = $2`,
            [JSON.stringify(result), row.id_registro_agenda],
          );
          enriquecidos++;
        } else {
          await pgPool.query(
            `UPDATE resumenes_diarios_agendas SET gemini_intentos = COALESCE(gemini_intentos, 0) + 1 WHERE id_registro_agenda = $1`,
            [row.id_registro_agenda],
          );
        }
      } catch (err) {
        if (err instanceof GeminiKeyError) {
          return { procesados, enriquecidos, errores, circuit_breaker: false, key_error: err.kind };
        }
        await pgPool.query(
          `UPDATE resumenes_diarios_agendas SET gemini_intentos = COALESCE(gemini_intentos, 0) + 1 WHERE id_registro_agenda = $1`,
          [row.id_registro_agenda],
        ).catch(() => {});
        errores++;
        console.error(`[byok-backfill] agendas id=${row.id_registro_agenda}:`, err);
      }
      await sleep(DELAY_MS);
    }
  } else {
    const { rows } = await pgPool.query<{
      id_evento: number;
      chat: Array<{ role: string; message: string }>;
    }>(
      `SELECT id_evento, chat FROM chats_logs
       WHERE id_cuenta = $1
         AND gemini_enriquecimiento IS NULL
         AND COALESCE(gemini_intentos, 0) < $2
         AND chat IS NOT NULL
         AND jsonb_array_length(chat) > 0
       ORDER BY fecha_y_hora_z DESC LIMIT $3`,
      [idCuenta, MAX_GEMINI_ATTEMPTS, cap],
    );

    for (const row of rows) {
      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        return { procesados, enriquecidos, errores, circuit_breaker: true, key_error: null };
      }
      procesados++;
      const messages = Array.isArray(row.chat) ? row.chat : [];
      const chatText = messages
        .map((m) => `${m.role === "lead" ? "Lead" : "Asesor"}: ${m.message}`)
        .join("\n");

      if (chatText.length < 50) continue;

      try {
        const result = await enrichWithGemini(chatText, "chat", idCuenta, apiKey);
        if (result) {
          await pgPool.query(
            `UPDATE chats_logs SET gemini_enriquecimiento = $1::jsonb WHERE id_evento = $2`,
            [JSON.stringify(result), row.id_evento],
          );
          enriquecidos++;
        } else {
          await pgPool.query(
            `UPDATE chats_logs SET gemini_intentos = COALESCE(gemini_intentos, 0) + 1 WHERE id_evento = $1`,
            [row.id_evento],
          );
        }
      } catch (err) {
        if (err instanceof GeminiKeyError) {
          return { procesados, enriquecidos, errores, circuit_breaker: false, key_error: err.kind };
        }
        await pgPool.query(
          `UPDATE chats_logs SET gemini_intentos = COALESCE(gemini_intentos, 0) + 1 WHERE id_evento = $1`,
          [row.id_evento],
        ).catch(() => {});
        errores++;
        console.error(`[byok-backfill] chats id=${row.id_evento}:`, err);
      }
      await sleep(DELAY_MS);
    }
  }

  return { procesados, enriquecidos, errores, circuit_breaker: false, key_error: null };
}

export async function runByokBackfill(idCuenta: number): Promise<ByokBackfillRunResult> {
  const cuentaRes = await pgPool.query<{
    gemini_api_key: string | null;
    gemini_premium_status: string | null;
    gemini_backfill_cap: number | null;
  }>(
    `SELECT gemini_api_key, gemini_premium_status, gemini_backfill_cap
     FROM cuentas WHERE id_cuenta = $1`,
    [idCuenta],
  );
  const cuenta = cuentaRes.rows[0];
  if (!cuenta) throw new Error(`Cuenta ${idCuenta} no encontrada`);

  const apiKey = resolveGeminiKey(cuenta);
  if (!apiKey) {
    throw new Error(`Cuenta ${idCuenta} no tiene llave Gemini activa (status: ${cuenta.gemini_premium_status})`);
  }

  const cap = cuenta.gemini_backfill_cap ?? DEFAULT_CAP;
  const estimate = await estimateByokBackfill(idCuenta);

  console.info(
    `[byok-backfill] Iniciando para cuenta ${idCuenta}: ` +
    `${estimate.total_a_procesar} conversaciones (cap=${cap}/tabla), ` +
    `costo estimado: ${estimate.costo_estimado_usd}`,
  );

  await pgPool.query(
    `UPDATE cuentas SET gemini_backfill_status = 'running' WHERE id_cuenta = $1`,
    [idCuenta],
  );

  const startTime = Date.now();
  let circuitBreaker = false;
  let keyError: string | null = null;

  const llamadasResult = await backfillTable("log_llamadas", idCuenta, apiKey, cap, startTime);
  if (llamadasResult.key_error) keyError = llamadasResult.key_error;
  if (llamadasResult.circuit_breaker) circuitBreaker = true;

  let agendasResult = { procesados: 0, enriquecidos: 0, errores: 0, circuit_breaker: false, key_error: null as string | null };
  let chatsResult = { procesados: 0, enriquecidos: 0, errores: 0, circuit_breaker: false, key_error: null as string | null };

  if (!circuitBreaker && !keyError) {
    agendasResult = await backfillTable("resumenes_diarios_agendas", idCuenta, apiKey, cap, startTime);
    if (agendasResult.key_error) keyError = agendasResult.key_error;
    if (agendasResult.circuit_breaker) circuitBreaker = true;
  }

  if (!circuitBreaker && !keyError) {
    chatsResult = await backfillTable("chats_logs", idCuenta, apiKey, cap, startTime);
    if (chatsResult.key_error) keyError = chatsResult.key_error;
    if (chatsResult.circuit_breaker) circuitBreaker = true;
  }

  const totalEnriquecidos = llamadasResult.enriquecidos + agendasResult.enriquecidos + chatsResult.enriquecidos;
  const finalStatus = keyError ? "failed" : circuitBreaker ? "pending" : "completed";

  await pgPool.query(
    `UPDATE cuentas SET gemini_backfill_status = $1 WHERE id_cuenta = $2`,
    [finalStatus, idCuenta],
  );

  console.info(
    `[byok-backfill] Finalizado cuenta ${idCuenta}: ` +
    `enriquecidos=${totalEnriquecidos} status=${finalStatus}` +
    (keyError ? ` key_error=${keyError}` : "") +
    (circuitBreaker ? " (circuit_breaker)" : ""),
  );

  return {
    id_cuenta: idCuenta,
    estimate,
    llamadas: { procesados: llamadasResult.procesados, enriquecidos: llamadasResult.enriquecidos, errores: llamadasResult.errores },
    agendas: { procesados: agendasResult.procesados, enriquecidos: agendasResult.enriquecidos, errores: agendasResult.errores },
    chats: { procesados: chatsResult.procesados, enriquecidos: chatsResult.enriquecidos, errores: chatsResult.errores },
    total_enriquecidos: totalEnriquecidos,
    circuit_breaker: circuitBreaker,
    key_error: keyError,
  };
}

export async function detectAndTriggerByokBackfills(): Promise<ByokBackfillRunResult[]> {
  const { rows } = await pgPool.query<{ id_cuenta: number }>(
    `SELECT id_cuenta FROM cuentas
     WHERE gemini_api_key IS NOT NULL
       AND gemini_premium_status = 'active'
       AND (gemini_backfill_status IS NULL OR gemini_backfill_status = 'pending')`,
  );

  if (rows.length === 0) {
    console.info("[byok-backfill] No hay tenants pendientes de backfill.");
    return [];
  }

  console.info(`[byok-backfill] ${rows.length} tenants pendientes de backfill BYOK.`);
  const results: ByokBackfillRunResult[] = [];

  for (const row of rows) {
    try {
      const result = await runByokBackfill(row.id_cuenta);
      results.push(result);
    } catch (err) {
      console.error(`[byok-backfill] Error en cuenta ${row.id_cuenta}:`, err);
      await pgPool.query(
        `UPDATE cuentas SET gemini_backfill_status = 'failed' WHERE id_cuenta = $1`,
        [row.id_cuenta],
      ).catch(() => {});
    }
  }

  return results;
}

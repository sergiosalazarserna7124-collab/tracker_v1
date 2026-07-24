import { db as pgPool } from "../../config/database.js";
import { enrichWithGemini, resolveGeminiKey } from "../ai/gemini-enrichment.service.js";
import { env } from "../../config/env.js";

type GeminiKeyMap = Map<number, string | null>;

// 30s margin before Cloud Run's 240s request timeout
const MAX_RUNTIME_MS = 210_000;
const DELAY_MS = 50;
const BATCH_SIZE = 50;
const MAX_GEMINI_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GeminiBackfillResult {
  success: boolean;
  tabla: string;
  total_candidatos: number;
  procesados: number;
  enriquecidos: number;
  skipped: number;
  errores: number;
  circuit_breaker: boolean;
}

async function backfillLlamadas(
  accountIds: number[] | undefined,
  daysBack: number,
  startTime: number,
  keyMap: GeminiKeyMap,
): Promise<GeminiBackfillResult> {
  const accountFilter = accountIds?.length
    ? "AND id_cuenta = ANY($2::int[])"
    : "";

  const params: unknown[] = [daysBack];
  if (accountIds?.length) params.push(accountIds);

  const { rows: candidates } = await pgPool.query<{
    id: number;
    id_cuenta: number;
    transcripcion: string;
  }>(
    `SELECT id, id_cuenta, transcripcion
     FROM log_llamadas
     WHERE gemini_enriquecimiento IS NULL
       AND COALESCE(gemini_intentos, 0) < ${MAX_GEMINI_ATTEMPTS}
       AND transcripcion IS NOT NULL
       AND LENGTH(transcripcion) >= 50
       AND ts > NOW() - ($1 || ' days')::interval
       ${accountFilter}
     ORDER BY ts DESC
     LIMIT 500`,
    params,
  );

  let procesados = 0;
  let enriquecidos = 0;
  let skipped = 0;
  let errores = 0;

  for (const row of candidates) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      return {
        success: true,
        tabla: "log_llamadas",
        total_candidatos: candidates.length,
        procesados,
        enriquecidos,
        skipped,
        errores,
        circuit_breaker: true,
      };
    }

    procesados++;
    try {
      const result = await enrichWithGemini(row.transcripcion, "llamada", row.id_cuenta, keyMap.get(row.id_cuenta) ?? null);
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
        skipped++;
      }
    } catch (err) {
      await pgPool.query(
        `UPDATE log_llamadas SET gemini_intentos = COALESCE(gemini_intentos, 0) + 1 WHERE id = $1`,
        [row.id],
      ).catch(() => {});
      errores++;
      console.error(`[gemini-backfill] log_llamadas id=${row.id}:`, err);
    }
    await sleep(DELAY_MS);
  }

  return {
    success: true,
    tabla: "log_llamadas",
    total_candidatos: candidates.length,
    procesados,
    enriquecidos,
    skipped,
    errores,
    circuit_breaker: false,
  };
}

async function backfillAgendas(
  accountIds: number[] | undefined,
  daysBack: number,
  startTime: number,
  keyMap: GeminiKeyMap,
): Promise<GeminiBackfillResult> {
  const accountFilter = accountIds?.length
    ? "AND id_cuenta = ANY($2::int[])"
    : "";

  const params: unknown[] = [daysBack];
  if (accountIds?.length) params.push(accountIds);

  const { rows: candidates } = await pgPool.query<{
    id_registro_agenda: number;
    id_cuenta: number;
    transcripcion_fathom: string;
    resumen_ia: string;
  }>(
    `SELECT id_registro_agenda, id_cuenta,
            COALESCE(transcripcion_fathom, resumen_ia) AS transcripcion_fathom,
            resumen_ia
     FROM resumenes_diarios_agendas
     WHERE gemini_enriquecimiento IS NULL
       AND COALESCE(gemini_intentos, 0) < ${MAX_GEMINI_ATTEMPTS}
       AND (transcripcion_fathom IS NOT NULL OR resumen_ia IS NOT NULL)
       AND LENGTH(COALESCE(transcripcion_fathom, resumen_ia, '')) >= 50
       AND fecha > NOW() - ($1 || ' days')::interval
       ${accountFilter}
     ORDER BY fecha DESC
     LIMIT 500`,
    params,
  );

  let procesados = 0;
  let enriquecidos = 0;
  let skipped = 0;
  let errores = 0;

  for (const row of candidates) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      return {
        success: true,
        tabla: "resumenes_diarios_agendas",
        total_candidatos: candidates.length,
        procesados,
        enriquecidos,
        skipped,
        errores,
        circuit_breaker: true,
      };
    }

    procesados++;
    const text = row.transcripcion_fathom || row.resumen_ia;
    try {
      const result = await enrichWithGemini(text, "videollamada", row.id_cuenta, keyMap.get(row.id_cuenta) ?? null);
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
        skipped++;
      }
    } catch (err) {
      await pgPool.query(
        `UPDATE resumenes_diarios_agendas SET gemini_intentos = COALESCE(gemini_intentos, 0) + 1 WHERE id_registro_agenda = $1`,
        [row.id_registro_agenda],
      ).catch(() => {});
      errores++;
      console.error(`[gemini-backfill] agendas id=${row.id_registro_agenda}:`, err);
    }
    await sleep(DELAY_MS);
  }

  return {
    success: true,
    tabla: "resumenes_diarios_agendas",
    total_candidatos: candidates.length,
    procesados,
    enriquecidos,
    skipped,
    errores,
    circuit_breaker: false,
  };
}

async function backfillChats(
  accountIds: number[] | undefined,
  daysBack: number,
  startTime: number,
  keyMap: GeminiKeyMap,
): Promise<GeminiBackfillResult> {
  const accountFilter = accountIds?.length
    ? "AND id_cuenta = ANY($2::int[])"
    : "";

  const params: unknown[] = [daysBack];
  if (accountIds?.length) params.push(accountIds);

  const { rows: candidates } = await pgPool.query<{
    id_evento: number;
    id_cuenta: number;
    chat: Array<{ role: string; message: string }>;
  }>(
    `SELECT id_evento, id_cuenta, chat
     FROM chats_logs
     WHERE gemini_enriquecimiento IS NULL
       AND COALESCE(gemini_intentos, 0) < ${MAX_GEMINI_ATTEMPTS}
       AND chat IS NOT NULL
       AND jsonb_array_length(chat) > 0
       AND fecha_y_hora_z > NOW() - ($1 || ' days')::interval
       ${accountFilter}
     ORDER BY fecha_y_hora_z DESC
     LIMIT 500`,
    params,
  );

  let procesados = 0;
  let enriquecidos = 0;
  let skipped = 0;
  let errores = 0;

  for (const row of candidates) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      return {
        success: true,
        tabla: "chats_logs",
        total_candidatos: candidates.length,
        procesados,
        enriquecidos,
        skipped,
        errores,
        circuit_breaker: true,
      };
    }

    procesados++;
    const messages = Array.isArray(row.chat) ? row.chat : [];
    const chatText = messages
      .map((m) => `${m.role === "lead" ? "Lead" : "Asesor"}: ${m.message}`)
      .join("\n");

    if (chatText.length < 50) {
      skipped++;
      continue;
    }

    try {
      const result = await enrichWithGemini(chatText, "chat", row.id_cuenta, keyMap.get(row.id_cuenta) ?? null);
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
        skipped++;
      }
    } catch (err) {
      await pgPool.query(
        `UPDATE chats_logs SET gemini_intentos = COALESCE(gemini_intentos, 0) + 1 WHERE id_evento = $1`,
        [row.id_evento],
      ).catch(() => {});
      errores++;
      console.error(`[gemini-backfill] chats id=${row.id_evento}:`, err);
    }
    await sleep(DELAY_MS);
  }

  return {
    success: true,
    tabla: "chats_logs",
    total_candidatos: candidates.length,
    procesados,
    enriquecidos,
    skipped,
    errores,
    circuit_breaker: false,
  };
}

export type BackfillTable = "log_llamadas" | "resumenes_diarios_agendas" | "chats_logs" | "all";

async function loadGeminiKeyMap(): Promise<GeminiKeyMap> {
  const { rows } = await pgPool.query<{ id_cuenta: number; gemini_api_key: string | null; gemini_premium_status: string | null }>(
    `SELECT id_cuenta, gemini_api_key, gemini_premium_status FROM cuentas WHERE gemini_api_key IS NOT NULL`,
  );
  const map: GeminiKeyMap = new Map();
  for (const r of rows) {
    map.set(r.id_cuenta, resolveGeminiKey(r));
  }
  return map;
}

export async function runGeminiBackfill(
  tabla: BackfillTable,
  accountIds?: number[],
  daysBack = 365,
): Promise<GeminiBackfillResult[]> {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY no configurada — el backfill requiere esta variable de entorno");
  }

  const keyMap = await loadGeminiKeyMap();
  const startTime = Date.now();
  const results: GeminiBackfillResult[] = [];

  const tables = tabla === "all"
    ? ["log_llamadas", "resumenes_diarios_agendas", "chats_logs"] as const
    : [tabla] as const;

  for (const t of tables) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) break;

    console.info(`[gemini-backfill] Iniciando backfill de ${t}...`);

    if (t === "log_llamadas") {
      results.push(await backfillLlamadas(accountIds, daysBack, startTime, keyMap));
    } else if (t === "resumenes_diarios_agendas") {
      results.push(await backfillAgendas(accountIds, daysBack, startTime, keyMap));
    } else {
      results.push(await backfillChats(accountIds, daysBack, startTime, keyMap));
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      procesados: acc.procesados + r.procesados,
      enriquecidos: acc.enriquecidos + r.enriquecidos,
      skipped: acc.skipped + r.skipped,
      errores: acc.errores + r.errores,
    }),
    { procesados: 0, enriquecidos: 0, skipped: 0, errores: 0 },
  );

  console.info(
    `[gemini-backfill] Finalizado: procesados=${totals.procesados} enriquecidos=${totals.enriquecidos} skipped=${totals.skipped} errores=${totals.errores}`,
  );

  return results;
}

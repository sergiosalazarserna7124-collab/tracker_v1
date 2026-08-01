import { db as pgPool } from "../../config/database.js";
import { extractLlamadaObjections } from "../ai/call-analysis.service.js";
import { analyzeChatBatch } from "../ai/batch-conversation-analysis.service.js";

const MAX_RUNTIME_MS = 210_000;
const DELAY_MS = 100;
const BATCH_SIZE = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ObjecionRaw {
  objecion: string;
  categoria: string;
  respuesta_vendedor?: string;
  contexto?: string;
}

function needsBackfill(obj: ObjecionRaw): boolean {
  return !obj.respuesta_vendedor || obj.respuesta_vendedor.trim() === "";
}

function mergeObjeciones(
  oldObjs: ObjecionRaw[],
  newObjs: ObjecionRaw[],
): ObjecionRaw[] {
  return oldObjs.map((old) => {
    if (!needsBackfill(old)) return old;

    const match = newObjs.find(
      (n) =>
        n.objecion.toLowerCase().trim() === old.objecion.toLowerCase().trim() ||
        n.categoria.toLowerCase() === old.categoria.toLowerCase(),
    );

    if (match?.respuesta_vendedor) {
      return {
        ...old,
        respuesta_vendedor: match.respuesta_vendedor,
        contexto: old.contexto || match.contexto || "",
      };
    }

    if (newObjs.length === 1 && oldObjs.length === 1 && newObjs[0].respuesta_vendedor) {
      return {
        ...old,
        respuesta_vendedor: newObjs[0].respuesta_vendedor,
        contexto: old.contexto || newObjs[0].contexto || "",
      };
    }

    return old;
  });
}

export interface BackfillResult {
  success: boolean;
  tabla: string;
  total_candidatos: number;
  procesados: number;
  actualizados: number;
  sin_cambio: number;
  errores: number;
  circuit_breaker: boolean;
}

type TenantConfig = Map<
  number,
  {
    openai_api_key: string | null;
    prompt_ventas: string | null;
    canales_activos: string[] | null;
  }
>;

async function loadTenantConfigs(): Promise<TenantConfig> {
  const { rows } = await pgPool.query<{
    id_cuenta: number;
    openai_api_key: string | null;
    prompt_ventas: string | null;
    canales_activos: unknown;
  }>(
    `SELECT id_cuenta, openai_api_key, prompt_ventas, canales_activos FROM cuentas`,
  );

  const map: TenantConfig = new Map();
  for (const row of rows) {
    map.set(row.id_cuenta, {
      openai_api_key: row.openai_api_key ?? null,
      prompt_ventas: row.prompt_ventas ?? null,
      canales_activos: Array.isArray(row.canales_activos)
        ? (row.canales_activos as string[])
        : null,
    });
  }
  return map;
}

async function backfillLlamadas(
  daysBack: number,
  startTime: number,
  tenants: TenantConfig,
): Promise<BackfillResult> {
  const { rows: candidates } = await pgPool.query<{
    id: number;
    id_cuenta: number;
    transcripcion: string;
    ia_objeciones: ObjecionRaw[];
  }>(
    `SELECT l.id, l.id_cuenta, l.transcripcion, l.ia_objeciones
     FROM log_llamadas l
     WHERE l.ia_objeciones IS NOT NULL
       AND jsonb_typeof(l.ia_objeciones) = 'array'
       AND jsonb_array_length(l.ia_objeciones) > 0
       AND l.ts > NOW() - ($1 || ' days')::interval
       AND l.transcripcion IS NOT NULL
       AND LENGTH(l.transcripcion) >= 30
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(l.ia_objeciones) AS obj
         WHERE obj->>'respuesta_vendedor' IS NULL OR obj->>'respuesta_vendedor' = ''
       )
     ORDER BY l.ts DESC
     LIMIT $2`,
    [daysBack, BATCH_SIZE],
  );

  let procesados = 0;
  let actualizados = 0;
  let sin_cambio = 0;
  let errores = 0;

  for (const row of candidates) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      return {
        success: true,
        tabla: "log_llamadas",
        total_candidatos: candidates.length,
        procesados,
        actualizados,
        sin_cambio,
        errores,
        circuit_breaker: true,
      };
    }

    procesados++;
    try {
      const cfg = tenants.get(row.id_cuenta);
      const newObjs = await extractLlamadaObjections(
        row.transcripcion,
        cfg?.prompt_ventas ?? null,
        cfg?.openai_api_key,
        row.id_cuenta,
        cfg?.canales_activos,
      );

      if (!newObjs || newObjs.length === 0) {
        sin_cambio++;
        await sleep(DELAY_MS);
        continue;
      }

      const merged = mergeObjeciones(row.ia_objeciones, newObjs);
      const changed = merged.some(
        (m, i) => m.respuesta_vendedor !== (row.ia_objeciones[i]?.respuesta_vendedor ?? ""),
      );

      if (!changed) {
        sin_cambio++;
        await sleep(DELAY_MS);
        continue;
      }

      await pgPool.query(
        `UPDATE log_llamadas SET ia_objeciones = $1::jsonb WHERE id = $2`,
        [JSON.stringify(merged), row.id],
      );
      actualizados++;
    } catch (err) {
      errores++;
      console.error(`[objeciones-backfill] log_llamadas id=${row.id}:`, err);
    }
    await sleep(DELAY_MS);
  }

  return {
    success: true,
    tabla: "log_llamadas",
    total_candidatos: candidates.length,
    procesados,
    actualizados,
    sin_cambio,
    errores,
    circuit_breaker: false,
  };
}

async function backfillChats(
  daysBack: number,
  startTime: number,
  tenants: TenantConfig,
): Promise<BackfillResult> {
  const { rows: candidates } = await pgPool.query<{
    id_evento: number;
    id_cuenta: number;
    chat: unknown;
    ia_objeciones: { objeciones: ObjecionRaw[]; sentimiento?: string; senales_compra?: string[] };
  }>(
    `SELECT c.id_evento, c.id_cuenta, c.chat, c.ia_objeciones
     FROM chats_logs c
     WHERE c.ia_objeciones IS NOT NULL
       AND jsonb_typeof(c.ia_objeciones) = 'object'
       AND c.ia_objeciones->'objeciones' IS NOT NULL
       AND jsonb_typeof(c.ia_objeciones->'objeciones') = 'array'
       AND jsonb_array_length(c.ia_objeciones->'objeciones') > 0
       AND c.fecha_y_hora_z > NOW() - ($1 || ' days')::interval
       AND c.chat IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(c.ia_objeciones->'objeciones') AS obj
         WHERE obj->>'respuesta_vendedor' IS NULL OR obj->>'respuesta_vendedor' = ''
       )
     ORDER BY c.fecha_y_hora_z DESC
     LIMIT $2`,
    [daysBack, BATCH_SIZE],
  );

  let procesados = 0;
  let actualizados = 0;
  let sin_cambio = 0;
  let errores = 0;

  for (const row of candidates) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      return {
        success: true,
        tabla: "chats_logs",
        total_candidatos: candidates.length,
        procesados,
        actualizados,
        sin_cambio,
        errores,
        circuit_breaker: true,
      };
    }

    procesados++;
    try {
      const messages = parseChatMessages(row.chat);
      if (messages.length === 0) {
        sin_cambio++;
        await sleep(DELAY_MS);
        continue;
      }

      const cfg = tenants.get(row.id_cuenta);
      const result = await analyzeChatBatch({
        messages,
        embudo: [],
        prompt_empresa: cfg?.prompt_ventas,
        openai_api_key: cfg?.openai_api_key,
        id_cuenta: row.id_cuenta,
      });

      const newObjs = result.ia_objeciones.objeciones;
      if (!newObjs || newObjs.length === 0) {
        sin_cambio++;
        await sleep(DELAY_MS);
        continue;
      }

      const oldObjs = row.ia_objeciones.objeciones;
      const merged = mergeObjeciones(oldObjs, newObjs);
      const changed = merged.some(
        (m, i) => m.respuesta_vendedor !== (oldObjs[i]?.respuesta_vendedor ?? ""),
      );

      if (!changed) {
        sin_cambio++;
        await sleep(DELAY_MS);
        continue;
      }

      const updatedIaObjeciones = {
        ...row.ia_objeciones,
        objeciones: merged,
      };

      await pgPool.query(
        `UPDATE chats_logs SET ia_objeciones = $1::jsonb WHERE id_evento = $2`,
        [JSON.stringify(updatedIaObjeciones), row.id_evento],
      );
      actualizados++;
    } catch (err) {
      errores++;
      console.error(`[objeciones-backfill] chats_logs id_evento=${row.id_evento}:`, err);
    }
    await sleep(DELAY_MS);
  }

  return {
    success: true,
    tabla: "chats_logs",
    total_candidatos: candidates.length,
    procesados,
    actualizados,
    sin_cambio,
    errores,
    circuit_breaker: false,
  };
}

async function backfillAgendas(
  daysBack: number,
  startTime: number,
  tenants: TenantConfig,
): Promise<BackfillResult> {
  const { rows: candidates } = await pgPool.query<{
    id_registro_agenda: number;
    id_cuenta: number;
    transcripcion_fathom: string;
    objeciones_ia: ObjecionRaw[] | { objeciones: ObjecionRaw[] };
  }>(
    `SELECT a.id_registro_agenda, a.id_cuenta, a.transcripcion_fathom, a.objeciones_ia
     FROM resumenes_diarios_agendas a
     WHERE a.objeciones_ia IS NOT NULL
       AND a.objeciones_ia::text != 'null'
       AND a.objeciones_ia::text != '[]'
       AND a.fecha > NOW() - ($1 || ' days')::interval
       AND a.transcripcion_fathom IS NOT NULL
       AND LENGTH(a.transcripcion_fathom) >= 30
       AND (
         (jsonb_typeof(a.objeciones_ia) = 'array' AND jsonb_array_length(a.objeciones_ia) > 0
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(a.objeciones_ia) AS obj
            WHERE obj->>'respuesta_vendedor' IS NULL OR obj->>'respuesta_vendedor' = ''
          ))
         OR
         (jsonb_typeof(a.objeciones_ia) = 'object'
          AND a.objeciones_ia->'objeciones' IS NOT NULL
          AND jsonb_typeof(a.objeciones_ia->'objeciones') = 'array'
          AND jsonb_array_length(a.objeciones_ia->'objeciones') > 0
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(a.objeciones_ia->'objeciones') AS obj
            WHERE obj->>'respuesta_vendedor' IS NULL OR obj->>'respuesta_vendedor' = ''
          ))
       )
     ORDER BY a.fecha DESC
     LIMIT $2`,
    [daysBack, BATCH_SIZE],
  );

  let procesados = 0;
  let actualizados = 0;
  let sin_cambio = 0;
  let errores = 0;

  for (const row of candidates) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      return {
        success: true,
        tabla: "resumenes_diarios_agendas",
        total_candidatos: candidates.length,
        procesados,
        actualizados,
        sin_cambio,
        errores,
        circuit_breaker: true,
      };
    }

    procesados++;
    try {
      const cfg = tenants.get(row.id_cuenta);
      const newObjs = await extractLlamadaObjections(
        row.transcripcion_fathom,
        cfg?.prompt_ventas ?? null,
        cfg?.openai_api_key,
        row.id_cuenta,
        cfg?.canales_activos,
      );

      if (!newObjs || newObjs.length === 0) {
        sin_cambio++;
        await sleep(DELAY_MS);
        continue;
      }

      const isArray = Array.isArray(row.objeciones_ia);
      const oldObjs: ObjecionRaw[] = isArray
        ? (row.objeciones_ia as ObjecionRaw[])
        : ((row.objeciones_ia as { objeciones: ObjecionRaw[] }).objeciones ?? []);

      const merged = mergeObjeciones(oldObjs, newObjs);
      const changed = merged.some(
        (m, i) => m.respuesta_vendedor !== (oldObjs[i]?.respuesta_vendedor ?? ""),
      );

      if (!changed) {
        sin_cambio++;
        await sleep(DELAY_MS);
        continue;
      }

      const updatedValue = isArray ? merged : { ...(row.objeciones_ia as Record<string, unknown>), objeciones: merged };

      await pgPool.query(
        `UPDATE resumenes_diarios_agendas SET objeciones_ia = $1::jsonb WHERE id_registro_agenda = $2`,
        [JSON.stringify(updatedValue), row.id_registro_agenda],
      );
      actualizados++;
    } catch (err) {
      errores++;
      console.error(`[objeciones-backfill] agendas id=${row.id_registro_agenda}:`, err);
    }
    await sleep(DELAY_MS);
  }

  return {
    success: true,
    tabla: "resumenes_diarios_agendas",
    total_candidatos: candidates.length,
    procesados,
    actualizados,
    sin_cambio,
    errores,
    circuit_breaker: false,
  };
}

function parseChatMessages(
  chat: unknown,
): Array<{ role: string; message: string; timestamp?: string; name?: string }> {
  if (!Array.isArray(chat)) return [];
  return chat
    .filter(
      (m): m is { role: string; message: string; timestamp?: string; name?: string } =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as Record<string, unknown>).role === "string" &&
        typeof (m as Record<string, unknown>).message === "string",
    )
    .slice(-50);
}

export type BackfillTabla = "log_llamadas" | "chats_logs" | "resumenes_diarios_agendas";

export async function runObjecionesBackfill(
  tabla: BackfillTabla,
  daysBack = 45,
): Promise<BackfillResult> {
  const startTime = Date.now();
  const tenants = await loadTenantConfigs();

  switch (tabla) {
    case "log_llamadas":
      return backfillLlamadas(daysBack, startTime, tenants);
    case "chats_logs":
      return backfillChats(daysBack, startTime, tenants);
    case "resumenes_diarios_agendas":
      return backfillAgendas(daysBack, startTime, tenants);
  }
}

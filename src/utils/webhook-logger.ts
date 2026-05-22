/**
 * webhook-logger.ts
 * Registra cada webhook entrante en webhook_events_log ANTES de procesarlo.
 * Guarda el payload raw exactamente como llegó + el resultado del procesamiento.
 *
 * Uso:
 *   const logId = await logWebhookReceived({ fuente, tipo_evento, location_id, id_cuenta, payload_raw });
 *   // ... procesar ...
 *   await logWebhookResult(logId, resultado, error, ms);
 */

import { db } from "../config/database.js";

interface LogWebhookInput {
  fuente: string;
  tipo_evento?: string | null;
  location_id?: string | null;
  id_cuenta?: number | null;
  payload_raw: unknown;
}

/**
 * Inserta el registro del webhook recibido.
 * Retorna el id del registro para luego actualizar con el resultado.
 * Fire-and-forget safe: si falla no rompe el flujo principal.
 */
export async function logWebhookReceived(input: LogWebhookInput): Promise<bigint | null> {
  try {
    const { rows } = await db.query<{ id: bigint }>(
      `INSERT INTO webhook_events_log
         (fuente, tipo_evento, location_id, id_cuenta, payload_raw)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id`,
      [
        input.fuente,
        input.tipo_evento ?? null,
        input.location_id ?? null,
        input.id_cuenta ?? null,
        JSON.stringify(input.payload_raw),
      ],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    // No romper el flujo principal si el log falla
    console.warn("[webhook-logger] Error insertando log:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Actualiza el registro con el resultado del procesamiento.
 * @param logId      id retornado por logWebhookReceived
 * @param resultado  objeto con el resultado (action, ids, etc.)
 * @param error      mensaje de error si falló
 * @param ms         milisegundos que tardó el procesamiento
 * @param id_cuenta  cuenta asociada al evento (si se conoce tras el procesamiento)
 */
export async function logWebhookResult(
  logId: bigint | null,
  resultado: unknown,
  error: string | null,
  ms: number,
  id_cuenta?: number | null,
): Promise<void> {
  if (!logId) return;
  try {
    if (id_cuenta != null) {
      await db.query(
        `UPDATE webhook_events_log
         SET procesado     = $1,
             resultado     = $2::jsonb,
             error         = $3,
             processing_ms = $4,
             id_cuenta     = $5
         WHERE id = $6`,
        [
          error === null,
          JSON.stringify(resultado ?? {}),
          error,
          ms,
          id_cuenta,
          logId,
        ],
      );
    } else {
      await db.query(
        `UPDATE webhook_events_log
         SET procesado     = $1,
             resultado     = $2::jsonb,
             error         = $3,
             processing_ms = $4
         WHERE id = $5`,
        [
          error === null,
          JSON.stringify(resultado ?? {}),
          error,
          ms,
          logId,
        ],
      );
    }
  } catch (err) {
    console.warn("[webhook-logger] Error actualizando resultado:", err instanceof Error ? err.message : err);
  }
}

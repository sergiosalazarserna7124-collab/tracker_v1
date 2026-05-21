/**
 * AUT-341: Recovery de webhooks efectivos sin procesar.
 *
 * Cloud Run puede terminar una instancia mientras processEffectiveCall() está en vuelo.
 * El callback .then(logWebhookResult) nunca se ejecuta → procesado=false queda en BD.
 *
 * Este cron recupera esas entradas:
 *  - Reintentar el procesamiento para entradas twilio/efectiva con <1h de antigüedad
 *  - Marcar como procesado=true + error='cloud-run-timeout' para las >1h (irrecuperables)
 */

import { db as pgPool } from "../../config/database.js";
import { processEffectiveCall } from "../webhooks/twilio.service.js";
import { logWebhookResult } from "../../utils/webhook-logger.js";
import { extractWebhookBody } from "../../utils/payload.utils.js";
import type { TwilioEventBody } from "../../schemas/webhooks/twilio.schema.js";

const MAX_RECOVERY_PER_RUN = 20;

interface WebhookPendiente {
  id: bigint;
  fuente: string;
  tipo_evento: string | null;
  payload_raw: unknown;
  received_at: Date;
}

export interface WebhookRecoveryResult {
  recuperados: number;
  marcados_timeout: number;
  errores: number;
  total_pendientes: number;
}

export async function runWebhookRecovery(): Promise<WebhookRecoveryResult> {
  const result: WebhookRecoveryResult = {
    recuperados: 0,
    marcados_timeout: 0,
    errores: 0,
    total_pendientes: 0,
  };

  // Obtener conteo real antes del LIMIT para reportar el total real en BD
  const { rows: countRows } = await pgPool.query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM webhook_events_log
     WHERE procesado = false
       AND received_at < NOW() - INTERVAL '5 minutes'`,
  );
  result.total_pendientes = parseInt(countRows[0].count, 10);

  // Buscar entradas sin procesar con al menos 5 min de antigüedad
  const { rows } = await pgPool.query<WebhookPendiente>(
    `SELECT id, fuente, tipo_evento, payload_raw, received_at
     FROM webhook_events_log
     WHERE procesado = false
       AND received_at < NOW() - INTERVAL '5 minutes'
     ORDER BY received_at ASC
     LIMIT $1`,
    [MAX_RECOVERY_PER_RUN],
  );

  if (rows.length === 0) return result;

  console.log(`[webhook-recovery] Encontrados ${rows.length} webhooks sin procesar`);

  for (const row of rows) {
    const edadMs = Date.now() - new Date(row.received_at).getTime();
    const edadMin = Math.round(edadMs / 60_000);
    const esIrrecuperable = edadMs > 60 * 60 * 1000; // >1h

    // Solo hacemos retry de webhooks twilio/efectiva — los demás no tienen procesamiento recuperable
    if (row.fuente === "twilio" && row.tipo_evento === "efectiva" && !esIrrecuperable) {
      const eventBody = extractWebhookBody<TwilioEventBody>(row.payload_raw);

      if (!eventBody) {
        console.warn(`[webhook-recovery] id=${row.id}: payload_raw no parseable — marcando timeout`);
        await markTimeout(row.id, "cloud-run-timeout: payload inválido");
        result.marcados_timeout++;
        continue;
      }

      const t0 = Date.now();
      try {
        const res = await processEffectiveCall(eventBody);
        const errorMsg = res?.success ? null : (res?.error ?? "error en recovery");
        await logWebhookResult(row.id, res?.data ?? null, errorMsg, Date.now() - t0);
        console.log(`[webhook-recovery] id=${row.id} (${edadMin}min): ${res?.success ? "ok" : "error"}`);
        if (res?.success) {
          result.recuperados++;
        } else {
          result.errores++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[webhook-recovery] id=${row.id}: excepción en processEffectiveCall: ${msg}`);
        await logWebhookResult(row.id, null, `recovery-error: ${msg}`, Date.now() - t0);
        result.errores++;
      }
    } else {
      // Irrecuperable (>1h) o tipo distinto de twilio/efectiva
      const razon = esIrrecuperable
        ? `cloud-run-timeout (${edadMin}min sin procesar)`
        : `tipo no recuperable: ${row.fuente}/${row.tipo_evento ?? "desconocido"}`;
      await markTimeout(row.id, razon);
      console.log(`[webhook-recovery] id=${row.id}: marcado como timeout — ${razon}`);
      result.marcados_timeout++;
    }
  }

  return result;
}

async function markTimeout(logId: bigint, razon: string): Promise<void> {
  try {
    await pgPool.query(
      `UPDATE webhook_events_log
       SET procesado     = true,
           error         = $1,
           processing_ms = 0
       WHERE id = $2`,
      [razon, logId],
    );
  } catch (err) {
    console.warn(`[webhook-recovery] Error marcando timeout id=${logId}:`, err instanceof Error ? err.message : err);
  }
}

import { db as pgPool } from "../../config/database.js";
import { safeAddContactTag, removeContactTag } from "../ghl-api.service.js";
import { withRetry } from "../../utils/retry.utils.js";
import { markTokenInvalid, savePendingTag } from "../ghl-token-guard.service.js";

const MAX_TAGS_PER_RUN = 200;
const MAX_RECONCILE_PER_RUN = 500;
const TAG_NAME = "sin_responder_chat";

interface ChatSinResponder {
  id_evento: number;
  id_cuenta: number;
  nombre_lead: string | null;
  id_lead: string | null;
  token_ghl: string | null;
  locationid: string | null;
  primer_msg_lead_at: Date;
  minutos_sin_respuesta: number;
}

export interface ChatSinResponderReconcileResult {
  reconciled: number;
  sin_token_ghl: number;
  errores: number;
}

export interface ChatSinResponderTagsResult {
  tagged: number;
  skipped_lock: number;
  sin_ghl_contact: number;
  sin_token_ghl: number;
  errores: number;
  reconcile: ChatSinResponderReconcileResult;
}

interface ChatTaggedPending {
  id_evento: number;
  id_cuenta: number;
  nombre_lead: string | null;
  id_lead: string | null;
  token_ghl: string | null;
}

/**
 * AUT-1531 — Reconciliación de remoción del tag `sin_responder_chat`.
 *
 * El auto-remove síncrono (chat.service §11) solo dispara cuando llega un webhook
 * outbound Y la etiqueta ya existe. En la práctica el bot suele responder ANTES de
 * que el cron etiquete, así que ese UPDATE matchea 0 filas y la etiqueta se queda
 * pegada para siempre → el cliente recibe recordatorios en bucle.
 *
 * Este barrido corrige el gap: para cada chat etiquetado y aún no removido donde el
 * agente/bot SÍ respondió (mensaje role=agent en el array O cualquier outbound en
 * chat_webhook_raw tras el primer mensaje del lead), quita el tag en GHL y marca
 * `chat_sin_responder_removed_at`. Idempotente y best-effort (removeContactTag
 * tolera 404). Solo remueve cuando hay evidencia de respuesta → no daña tags legítimos.
 */
export async function reconcileSinResponderRemovals(): Promise<ChatSinResponderReconcileResult> {
  const result: ChatSinResponderReconcileResult = {
    reconciled: 0,
    sin_token_ghl: 0,
    errores: 0,
  };

  const pendientes = await withRetry(
    () =>
      pgPool.query<ChatTaggedPending>(
        `SELECT cl.id_evento, cl.id_cuenta, cl.nombre_lead, cl.id_lead, c.token_ghl
           FROM chats_logs cl
           JOIN cuentas c ON c.id_cuenta = cl.id_cuenta
          WHERE cl.chat_sin_responder_tagged_at IS NOT NULL
            AND cl.chat_sin_responder_removed_at IS NULL
            AND c.estado_cuenta = 'activo'
            AND cl.id_lead IS NOT NULL
            AND (
              EXISTS (
                SELECT 1 FROM jsonb_array_elements(cl.chat) m
                WHERE m->>'role' = 'agent'
              )
              OR EXISTS (
                SELECT 1 FROM chat_webhook_raw r
                WHERE r.location_id = c.locationid
                  AND r.direction = 'outbound'
                  AND r.payload->>'conversationId' = cl.chatid
                  AND r.received_at >= cl.primer_msg_lead_at
                  -- Cota explícita → usa idx_chat_raw_received y evita scan total de raw.
                  -- Los tags pendientes tienen <=30 días; 35 días cubre con margen.
                  AND r.received_at >= NOW() - INTERVAL '35 days'
              )
            )
          ORDER BY cl.chat_sin_responder_tagged_at ASC
          LIMIT $1`,
        [MAX_RECONCILE_PER_RUN],
      ),
    { label: "sin-responder-reconcile-find" },
  );

  console.info(`[sin-responder-tags] Reconciliación: ${pendientes.rows.length} tags a remover`);

  for (const chat of pendientes.rows) {
    if (!chat.id_lead || !chat.token_ghl) {
      result.sin_token_ghl++;
      continue;
    }
    try {
      await removeContactTag(chat.id_lead, chat.token_ghl, TAG_NAME);
      await pgPool.query(
        `UPDATE chats_logs
            SET chat_sin_responder_removed_at = NOW(),
                chat_sin_responder_tagged_at  = NULL
          WHERE id_evento = $1
            AND chat_sin_responder_removed_at IS NULL`,
        [chat.id_evento],
      );
      result.reconciled++;
      console.info(
        `[sin-responder-tags] Reconciliado (removido) evento=${chat.id_evento} cuenta=${chat.id_cuenta} lead="${chat.nombre_lead}"`,
      );
    } catch (err) {
      const isTokenInvalid = (err as Error & { isTokenInvalid?: boolean }).isTokenInvalid;
      if (isTokenInvalid) {
        await markTokenInvalid(chat.id_cuenta);
        result.sin_token_ghl++;
      } else {
        result.errores++;
        console.error(`[sin-responder-tags] Error reconciliando evento=${chat.id_evento}:`, err);
      }
    }
  }

  console.info(
    `[sin-responder-tags] Reconciliación resultado: reconciled=${result.reconciled} ` +
      `sin_token=${result.sin_token_ghl} errores=${result.errores}`,
  );

  return result;
}

export async function runChatSinResponderTags(): Promise<ChatSinResponderTagsResult> {
  // AUT-1531: primero limpiar tags pegados de chats ya respondidos (auto-heal),
  // luego etiquetar los nuevos que de verdad siguen sin respuesta.
  const reconcile = await reconcileSinResponderRemovals();

  const result: ChatSinResponderTagsResult = {
    tagged: 0,
    skipped_lock: 0,
    sin_ghl_contact: 0,
    sin_token_ghl: 0,
    errores: 0,
    reconcile,
  };

  const chats = await withRetry(
    () =>
      pgPool.query<ChatSinResponder>(
        `SELECT
           cl.id_evento,
           cl.id_cuenta,
           cl.nombre_lead,
           cl.id_lead,
           c.token_ghl,
           c.locationid,
           cl.primer_msg_lead_at,
           EXTRACT(EPOCH FROM (NOW() - cl.primer_msg_lead_at)) / 60 AS minutos_sin_respuesta
         FROM chats_logs cl
         JOIN cuentas c ON c.id_cuenta = cl.id_cuenta
         LEFT JOIN metas_cuenta mc ON mc.id_cuenta = cl.id_cuenta
         WHERE cl.primer_msg_lead_at IS NOT NULL
           AND cl.chat_sin_responder_tagged_at IS NULL
           AND cl.chat_sin_responder_removed_at IS NULL
           AND cl.primer_msg_lead_at >= NOW() - INTERVAL '48 hours'
           AND EXTRACT(EPOCH FROM (NOW() - cl.primer_msg_lead_at)) / 60 >= COALESCE(mc.meta_tag_sin_responder_wait_min, 60)
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(cl.chat) m
             WHERE m->>'role' = 'agent'
           )
           -- AUT-1531: el array chats_logs.chat es lossy para el canal "Custom"/API
           -- (los outbound del bot llegan con id vacío y no siempre quedan como role=agent).
           -- chat_webhook_raw SÍ registra de forma confiable todos los webhooks recibidos,
           -- así que cruzamos contra él: si el bot/agente ya respondió (outbound) después
           -- del primer mensaje del lead, NO etiquetar (evita falsos positivos → spam de
           -- recordatorios). Guard puramente conservador: solo suprime tags, nunca fuerza uno.
           AND NOT EXISTS (
             SELECT 1 FROM chat_webhook_raw r
             WHERE r.location_id = c.locationid
               AND r.direction = 'outbound'
               AND r.payload->>'conversationId' = cl.chatid
               AND r.received_at >= cl.primer_msg_lead_at
               -- Cota explícita para que el planner use idx_chat_raw_received y no
               -- escanee toda la tabla raw (463k filas / 1.4GB). Los candidatos a
               -- etiquetar tienen primer_msg_lead_at < 48h, así que 3 días nunca
               -- excluye un outbound válido.
               AND r.received_at >= NOW() - INTERVAL '3 days'
           )
           AND c.estado_cuenta = 'activo'
           AND c.monto_mensualidad > 0
         ORDER BY cl.primer_msg_lead_at ASC
         LIMIT $1`,
        [MAX_TAGS_PER_RUN],
      ),
    { label: "sin-responder-tags-find" },
  );

  console.info(`[sin-responder-tags] Chats pendientes de tag: ${chats.rows.length}`);

  for (const chat of chats.rows) {
    if (!chat.id_lead) {
      result.sin_ghl_contact++;
      continue;
    }
    if (!chat.token_ghl) {
      result.sin_token_ghl++;
      continue;
    }

    const lock = await pgPool.query(
      `UPDATE chats_logs
       SET chat_sin_responder_tagged_at = NOW()
       WHERE id_evento = $1
         AND chat_sin_responder_tagged_at IS NULL
       RETURNING id_evento`,
      [chat.id_evento],
    );
    if (lock.rowCount === 0) {
      result.skipped_lock++;
      continue;
    }

    try {
      await safeAddContactTag(chat.id_lead, chat.token_ghl, TAG_NAME, chat.locationid);
      result.tagged++;
      console.info(
        `[sin-responder-tags] Tagged evento=${chat.id_evento} cuenta=${chat.id_cuenta} lead="${chat.nombre_lead}" (${Math.round(chat.minutos_sin_respuesta)}m)`,
      );
    } catch (err) {
      const isTokenInvalid = (err as Error & { isTokenInvalid?: boolean }).isTokenInvalid;
      if (isTokenInvalid) {
        await savePendingTag(chat.id_cuenta, chat.id_lead, TAG_NAME, String(err));
        await markTokenInvalid(chat.id_cuenta);
        result.sin_token_ghl++;
      } else {
        await pgPool.query(
          `UPDATE chats_logs SET chat_sin_responder_tagged_at = NULL WHERE id_evento = $1`,
          [chat.id_evento],
        );
        result.errores++;
        console.error(`[sin-responder-tags] Error tagging evento=${chat.id_evento}:`, err);
      }
    }
  }

  console.info(
    `[sin-responder-tags] Resultado: tagged=${result.tagged} skipped_lock=${result.skipped_lock} ` +
      `sin_contact=${result.sin_ghl_contact} sin_token=${result.sin_token_ghl} errores=${result.errores} ` +
      `reconciled=${result.reconcile.reconciled}`,
  );

  return result;
}

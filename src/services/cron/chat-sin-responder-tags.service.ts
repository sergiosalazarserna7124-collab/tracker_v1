import { db as pgPool } from "../../config/database.js";
import { safeAddContactTag } from "../ghl-api.service.js";
import { withRetry } from "../../utils/retry.utils.js";
import { markTokenInvalid, savePendingTag } from "../ghl-token-guard.service.js";

const MAX_TAGS_PER_RUN = 200;
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

export interface ChatSinResponderTagsResult {
  tagged: number;
  skipped_lock: number;
  sin_ghl_contact: number;
  sin_token_ghl: number;
  errores: number;
}

export async function runChatSinResponderTags(): Promise<ChatSinResponderTagsResult> {
  const result: ChatSinResponderTagsResult = {
    tagged: 0,
    skipped_lock: 0,
    sin_ghl_contact: 0,
    sin_token_ghl: 0,
    errores: 0,
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
      `sin_contact=${result.sin_ghl_contact} sin_token=${result.sin_token_ghl} errores=${result.errores}`,
  );

  return result;
}

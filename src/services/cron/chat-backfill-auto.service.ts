import { db } from "../../config/database.js";
import { executeChatBackfill } from "../quick-triggers/chat-backfill.service.js";

const LOOKBACK_DAYS = 3;
const MAX_CONVERSATIONS_PER_ACCOUNT = 500;
const INTER_ACCOUNT_DELAY_MS = 2_000;

interface AccountWithoutWebhooks {
  id_cuenta: number;
  nombre_cuenta: string | null;
}

export interface ChatBackfillAutoResult {
  accountsChecked: number;
  accountsBackfilled: number;
  totalNewConversations: number;
  totalUpdatedConversations: number;
  totalMessages: number;
  errors: string[];
}

export async function runChatBackfillAuto(): Promise<ChatBackfillAutoResult> {
  const result: ChatBackfillAutoResult = {
    accountsChecked: 0,
    accountsBackfilled: 0,
    totalNewConversations: 0,
    totalUpdatedConversations: 0,
    totalMessages: 0,
    errors: [],
  };

  const { rows: accounts } = await db.query<AccountWithoutWebhooks>(
    `SELECT c.id_cuenta, c.nombre_cuenta
     FROM cuentas c
     WHERE c.estado_cuenta = 'activo'
       AND c.locationid IS NOT NULL AND c.locationid != ''
       AND c.token_ghl IS NOT NULL AND c.token_ghl != ''
       AND c.token_ghl_status = 'ok'
       AND c.ghl_app_uninstalled_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM chat_webhook_raw cwr
         WHERE cwr.location_id = c.locationid
           AND cwr.received_at >= NOW() - INTERVAL '7 days'
       )
     ORDER BY c.id_cuenta`,
  );

  result.accountsChecked = accounts.length;
  console.log(`[chat-backfill-auto] Found ${accounts.length} accounts without recent chat webhooks`);

  if (accounts.length === 0) return result;

  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - LOOKBACK_DAYS);
  const sinceDateStr = sinceDate.toISOString().split("T")[0];

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    try {
      console.log(`[chat-backfill-auto] Running backfill for cuenta ${account.id_cuenta} (${account.nombre_cuenta}) since ${sinceDateStr}`);

      const backfillResult = await executeChatBackfill(account.id_cuenta, {
        since_date: sinceDateStr,
        max_conversations: MAX_CONVERSATIONS_PER_ACCOUNT,
        dry_run: false,
      });

      result.accountsBackfilled++;
      result.totalNewConversations += backfillResult.newConversations;
      result.totalUpdatedConversations += backfillResult.updatedConversations;
      result.totalMessages += backfillResult.totalMessagesImported;

      console.log(
        `[chat-backfill-auto] cuenta ${account.id_cuenta}: ${backfillResult.newConversations} new, ${backfillResult.updatedConversations} updated, ${backfillResult.totalMessagesImported} msgs`,
      );
    } catch (err) {
      const msg = `cuenta ${account.id_cuenta} (${account.nombre_cuenta}): ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(msg);
      console.error(`[chat-backfill-auto] Error: ${msg}`);
    }

    if (i < accounts.length - 1) {
      await new Promise((r) => setTimeout(r, INTER_ACCOUNT_DELAY_MS));
    }
  }

  console.log(
    `[chat-backfill-auto] Done: ${result.accountsBackfilled}/${result.accountsChecked} accounts, ${result.totalNewConversations} new convs, ${result.totalMessages} msgs, ${result.errors.length} errors`,
  );

  return result;
}

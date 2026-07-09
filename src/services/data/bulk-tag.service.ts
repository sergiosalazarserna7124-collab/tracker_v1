import {
  getAccountById,
  addContactTags,
  removeContactTag,
  updateContactCustomFields,
} from "../ghl-api.service.js";
import { processInChunks } from "../../utils/batch.utils.js";

export interface BulkTagRequest {
  id_cuenta: number;
  contactIds: string[];
  operation: "add" | "remove";
  tags?: string[];
  customField?: { key: string; value: string };
}

interface ContactResult {
  contactId: string;
  success: boolean;
  error?: string;
}

export interface BulkTagResponse {
  ok: boolean;
  results: ContactResult[];
  applied: number;
  failed: number;
}

export async function bulkTagContacts(req: BulkTagRequest): Promise<BulkTagResponse> {
  const account = await getAccountById(req.id_cuenta);
  if (!account) {
    throw new Error(`Cuenta ${req.id_cuenta} no encontrada`);
  }
  if (!account.token_ghl) {
    throw new Error(`Cuenta ${req.id_cuenta} sin token GHL configurado`);
  }

  const token = account.token_ghl;
  const hasTags = req.tags && req.tags.length > 0;
  const hasCustomField = req.customField != null;

  if (!hasTags && !hasCustomField) {
    throw new Error("Debe enviar al menos tags o customField");
  }

  const results = await processInChunks<string, ContactResult>(
    req.contactIds,
    5,
    500,
    async (contactId) => {
      try {
        if (hasTags) {
          if (req.operation === "add") {
            await addContactTags(contactId, token, req.tags!);
          } else {
            for (const tag of req.tags!) {
              await removeContactTag(contactId, token, tag);
            }
          }
        }

        if (hasCustomField) {
          await updateContactCustomFields(contactId, token, [
            { key: req.customField!.key, field_value: req.customField!.value },
          ]);
        }

        return { contactId, success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[bulk-tag] contactId=${contactId} error: ${message}`);
        return { contactId, success: false, error: message };
      }
    },
  );

  const applied = results.filter((r) => r.success).length;
  return { ok: true, results, applied, failed: results.length - applied };
}

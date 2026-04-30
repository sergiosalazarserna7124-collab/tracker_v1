/**
 * ghl-token-guard.service.ts
 * 
 * Detecta tokens GHL inválidos (401) y:
 * 1. Marca la cuenta como token_ghl_status='invalid' en BD
 * 2. Persiste la acción fallida en ghl_pending_actions para reintento futuro
 * 3. Expone retry: cuando el token se actualiza, reintenta todas las pendientes
 */

import { db } from "../config/database.js";
import { drizzleDb } from "../config/drizzle.js";
import { cuentas, ghlPendingActions } from "../db/schema.js";
import { eq, isNull } from "drizzle-orm";
import { addContactNote, addContactTag, addContactTags } from "./ghl-api.service.js";

// ─── Marcar token como inválido en BD ───────────────────────────────────────

export async function markTokenInvalid(idCuenta: number): Promise<void> {
  try {
    await drizzleDb
      .update(cuentas)
      .set({ token_ghl_status: "invalid" })
      .where(eq(cuentas.id_cuenta, idCuenta));
    console.warn(`[GHL TokenGuard] Cuenta ${idCuenta}: token marcado como 'invalid'`);
  } catch (err) {
    console.error("[GHL TokenGuard] Error actualizando token_ghl_status:", err);
  }
}

export async function markTokenOk(idCuenta: number): Promise<void> {
  try {
    await drizzleDb
      .update(cuentas)
      .set({ token_ghl_status: "ok" })
      .where(eq(cuentas.id_cuenta, idCuenta));
  } catch (err) {
    console.error("[GHL TokenGuard] Error actualizando token_ghl_status a ok:", err);
  }
}

// ─── Guardar acción pendiente ────────────────────────────────────────────────

export async function savePendingNote(
  idCuenta: number,
  contactId: string,
  noteBody: string,
  errorMsg?: string,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO ghl_pending_actions (id_cuenta, contact_id, action_type, payload, last_error)
       VALUES ($1, $2, 'note', $3::jsonb, $4)`,
      [idCuenta, contactId, JSON.stringify({ body: noteBody }), errorMsg ?? "Token GHL inválido"],
    );
    console.info(`[GHL TokenGuard] Nota pendiente guardada para cuenta=${idCuenta} contact=${contactId}`);
  } catch (err) {
    console.error("[GHL TokenGuard] Error guardando nota pendiente:", err);
  }
}

export async function savePendingTag(
  idCuenta: number,
  contactId: string,
  tag: string,
  errorMsg?: string,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO ghl_pending_actions (id_cuenta, contact_id, action_type, payload, last_error)
       VALUES ($1, $2, 'tag', $3::jsonb, $4)`,
      [idCuenta, contactId, JSON.stringify({ tag }), errorMsg ?? "Token GHL inválido"],
    );
  } catch (err) {
    console.error("[GHL TokenGuard] Error guardando tag pendiente:", err);
  }
}

// ─── Validar token contra GHL (call mínimo de prueba) ────────────────────────

export async function validateGhlToken(token: string, locationId: string): Promise<boolean> {
  try {
    const bearer = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
    const res = await fetch(`https://services.leadconnectorhq.com/locations/${locationId}`, {
      headers: { Authorization: bearer, Version: "2021-07-28" },
      signal: AbortSignal.timeout(8000),
    });
    return res.status !== 401 && res.status !== 403;
  } catch {
    return false;
  }
}

// ─── Reintentar pendientes de una cuenta ────────────────────────────────────

export async function retryPendingActions(
  idCuenta: number,
  tokenGhl: string,
): Promise<{ success: number; failed: number }> {
  const pendientes = await drizzleDb
    .select()
    .from(ghlPendingActions)
    .where(eq(ghlPendingActions.id_cuenta, idCuenta))
    .orderBy(ghlPendingActions.created_at);

  const pending = pendientes.filter(p => p.resolved_at === null);

  console.info(`[GHL TokenGuard] Reintentando ${pending.length} acciones pendientes para cuenta=${idCuenta}`);
  
  let success = 0;
  let failed = 0;

  for (const action of pending) {
    // Delay entre reintentos para no saturar GHL
    await new Promise(r => setTimeout(r, 600));

    try {
      const payload = action.payload as Record<string, unknown>;

      if (action.action_type === "note" && payload.body) {
        await addContactNote(action.contact_id, tokenGhl, String(payload.body));
      } else if (action.action_type === "tag" && payload.tag) {
        await addContactTag(action.contact_id, tokenGhl, String(payload.tag));
      } else if (action.action_type === "tags" && Array.isArray(payload.tags)) {
        await addContactTags(action.contact_id, tokenGhl, payload.tags as string[]);
      }

      // Marcar como resuelta
      await db.query(
        `UPDATE ghl_pending_actions SET resolved_at = NOW() WHERE id = $1`,
        [action.id],
      );
      success++;
    } catch (err) {
      // Incrementar retry_count y guardar el error
      await db.query(
        `UPDATE ghl_pending_actions SET retry_count = retry_count + 1, last_error = $2 WHERE id = $1`,
        [action.id, String(err)],
      );
      failed++;
      console.error(`[GHL TokenGuard] Fallo reintento acción id=${action.id}:`, err);
    }
  }

  console.info(`[GHL TokenGuard] Reintentos: ${success} ok, ${failed} fallidos`);
  return { success, failed };
}

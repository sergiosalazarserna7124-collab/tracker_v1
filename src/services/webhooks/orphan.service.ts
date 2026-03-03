import { eq, and } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { eventosHuerfanos } from "../../db/schema.js";
import { processFathomCall } from "./fathom.service.js";
import { processTwilioWebhook } from "./twilio.service.js";
import type { ServiceResult } from "../../types/index.js";

export async function retryOrphanEvent(
  idHuerfano: number,
  emailCorregido: string,
): Promise<ServiceResult> {
  const [orphan] = await drizzleDb
    .select()
    .from(eventosHuerfanos)
    .where(eq(eventosHuerfanos.id_huerfano, idHuerfano))
    .limit(1);

  if (!orphan) {
    return { success: false, error: `Evento huérfano ${idHuerfano} no encontrado` };
  }

  if (orphan.estado !== "pendiente") {
    return { success: false, error: `Evento huérfano ${idHuerfano} ya fue procesado (estado: ${orphan.estado})` };
  }

  const payload = orphan.payload_original as Record<string, unknown>;

  if (orphan.origen === "fathom") {
    const invitees = Array.isArray(payload.calendar_invitees)
      ? payload.calendar_invitees
      : [];

    invitees.push({
      email: emailCorregido,
      is_external: true,
      name: emailCorregido,
    });

    payload.calendar_invitees = invitees;

    await drizzleDb
      .update(eventosHuerfanos)
      .set({ estado: "resuelto", updated_at: new Date() })
      .where(eq(eventosHuerfanos.id_huerfano, idHuerfano));

    processFathomCall(orphan.id_cuenta ?? 0, payload as never).catch((err) => {
      console.error(`[OrphanRetry] Error re-procesando Fathom huérfano ${idHuerfano}:`, err);
    });

    return { success: true, data: { id_huerfano: idHuerfano, origen: "fathom" } };
  }

  if (orphan.origen === "twilio") {
    const customData = (payload.customData ?? {}) as Record<string, unknown>;
    customData.email = emailCorregido;
    payload.customData = customData;

    await drizzleDb
      .update(eventosHuerfanos)
      .set({ estado: "resuelto", updated_at: new Date() })
      .where(eq(eventosHuerfanos.id_huerfano, idHuerfano));

    processTwilioWebhook(payload as never).catch((err) => {
      console.error(`[OrphanRetry] Error re-procesando Twilio huérfano ${idHuerfano}:`, err);
    });

    return { success: true, data: { id_huerfano: idHuerfano, origen: "twilio" } };
  }

  return { success: false, error: `Origen desconocido: ${orphan.origen}` };
}

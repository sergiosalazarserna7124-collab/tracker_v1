import { eq, and, or, desc, sql, type SQL } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { agendas, cuentas } from "../../db/schema.js";
import { withRetry } from "../../utils/retry.utils.js";
import { safeAddContactTag, removeContactTag, GHL_TAGS } from "../ghl-api.service.js";
import { getAccessToken } from "../oauth/ghl-oauth.service.js";
import type { AsistenciaEventBody } from "../../schemas/webhooks/asistencia.schema.js";

const LOG_PREFIX = "[Asistencia]";

interface ProcessAsistenciaResult {
  action: "updated" | "not_found" | "already_processed";
  id_registro_agenda?: number;
  categoria?: string;
}

export async function processAsistencia(
  idCuenta: number,
  payload: AsistenciaEventBody,
): Promise<ProcessAsistenciaResult> {
  const { tipo, email_lead, ghl_contact_id, fecha_reunion } = payload;

  if (!email_lead && !ghl_contact_id) {
    throw new Error("Se requiere email_lead o ghl_contact_id");
  }

  // ── Buscar cita PDTE ──────────────────────────────────────────────────────
  const conditions = [
    eq(agendas.id_cuenta, idCuenta),
    eq(agendas.categoria, "PDTE"),
  ];

  const identityConditions: SQL[] = [];
  if (email_lead) {
    identityConditions.push(eq(sql`LOWER(${agendas.email_lead})`, email_lead.toLowerCase()));
  }
  if (ghl_contact_id) {
    identityConditions.push(eq(agendas.ghl_contact_id, ghl_contact_id));
  }

  const [existing] = await withRetry(
    () =>
      drizzleDb
        .select({
          id: agendas.id_registro_agenda,
          categoria: agendas.categoria,
          ghl_contact_id: agendas.ghl_contact_id,
        })
        .from(agendas)
        .where(and(...conditions, or(...identityConditions)))
        .orderBy(desc(agendas.fechaReunion), desc(agendas.fecha))
        .limit(1),
    { label: "Asistencia/findPdte" },
  );

  if (!existing) {
    console.info(
      `${LOG_PREFIX} No PDTE appointment found for id_cuenta=${idCuenta}, email=${email_lead ?? "N/A"}, contactId=${ghl_contact_id ?? "N/A"}`,
    );
    return { action: "not_found" };
  }

  // ── Determinar nueva categoría ────────────────────────────────────────────
  const nuevaCategoria = tipo === "asistio" ? "No_Ofertada" : "no_show";

  // ── UPDATE ────────────────────────────────────────────────────────────────
  const updateFields: Record<string, unknown> = {
    categoria: nuevaCategoria,
  };

  if (fecha_reunion) {
    const parsed = new Date(fecha_reunion);
    if (!Number.isNaN(parsed.getTime())) {
      updateFields.fechaReunion = parsed;
    }
  }

  await withRetry(
    () =>
      drizzleDb
        .update(agendas)
        .set(updateFields)
        .where(eq(agendas.id_registro_agenda, existing.id)),
    { label: "Asistencia/updateAgenda" },
  );

  console.info(
    `${LOG_PREFIX} Updated agenda ${existing.id} for id_cuenta=${idCuenta} → ${nuevaCategoria}`,
  );

  // ── GHL tags (best effort) ────────────────────────────────────────────────
  if (existing.ghl_contact_id) {
    try {
      const [account] = await withRetry(
        () =>
          drizzleDb
            .select({ token_ghl: cuentas.token_ghl, locationid: cuentas.locationid })
            .from(cuentas)
            .where(eq(cuentas.id_cuenta, idCuenta))
            .limit(1),
        { label: "Asistencia/getAccount" },
      );

      // App-only: token OAuth (auto-refresh) primero; token_ghl legacy fallback.
      const asistToken = (await getAccessToken(account?.locationid ?? "")) || account?.token_ghl;
      if (asistToken) {
        if (tipo === "no_show") {
          await safeAddContactTag(
            existing.ghl_contact_id,
            asistToken,
            GHL_TAGS.noshow,
            account?.locationid,
          );
        } else {
          // asistió manualmente: quitar tag de noshow si existía
          await removeContactTag(existing.ghl_contact_id, asistToken, GHL_TAGS.noshow).catch(() => {});
        }
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} GHL tag sync failed for contact ${existing.ghl_contact_id}:`, err);
    }
  }

  return {
    action: "updated",
    id_registro_agenda: existing.id,
    categoria: nuevaCategoria,
  };
}

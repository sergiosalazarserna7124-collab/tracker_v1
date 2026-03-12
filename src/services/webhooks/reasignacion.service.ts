import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { llamadas } from "../../db/schema.js";
import { getAccountByLocationId } from "../ghl-api.service.js";
import { withRetry } from "../../utils/retry.utils.js";
import type { ReasignacionBodyPayload } from "../../schemas/webhooks/reasignacion.schema.js";
import type { ServiceResult } from "../../types/index.js";

const ESTADOS_REASIGNABLES = [
  "pdte",
  "seguimiento",
  "programado",
  "no_contestada",
  "no_contestado",
] as const;

function extractFields(body: ReasignacionBodyPayload) {
  const cd = body.customData;
  return {
    idUserGhl: cd.idusuario.trim(),
    closerMail: cd.correocloser.trim(),
    nombreCloser: cd.nombrecloser.trim(),
    locationId: cd.locationid.trim(),
  };
}

export async function processReasignacion(
  body: ReasignacionBodyPayload,
): Promise<ServiceResult> {
  const fields = extractFields(body);
  const label = "Reasignacion";

  if (!fields.idUserGhl) {
    return { success: false, error: "idusuario es requerido" };
  }

  let idCuenta: number | null = null;
  if (fields.locationId) {
    try {
      const account = await getAccountByLocationId(fields.locationId);
      idCuenta = account?.id_cuenta ?? null;
    } catch (err) {
      console.error(`[${label}] Error buscando cuenta para locationId="${fields.locationId}":`, err);
    }
  }

  type ExistingRow = {
    id_registro: number;
    estado: string | null;
  };

  let existing: ExistingRow | null = null;

  try {
    const rows = await withRetry(
      () =>
        drizzleDb
          .select({
            id_registro: llamadas.id_registro,
            estado: llamadas.estado,
          })
          .from(llamadas)
          .where(
            and(
              eq(llamadas.id_user_ghl, fields.idUserGhl),
              idCuenta ? eq(llamadas.id_cuenta, idCuenta) : undefined,
              or(
                inArray(llamadas.estado, [...ESTADOS_REASIGNABLES]),
                isNull(llamadas.estado),
              ),
            ),
          )
          .orderBy(desc(llamadas.id_registro))
          .limit(1),
      { label: `${label}/findExisting` },
    );

    existing = rows[0] ?? null;
  } catch (err) {
    console.error(`[${label}] Error buscando registro para idUserGhl="${fields.idUserGhl}":`, err);
    return { success: false, error: "Database error searching for existing record" };
  }

  if (existing) {
    try {
      await withRetry(
        () =>
          drizzleDb
            .update(llamadas)
            .set({
              closer_mail: fields.closerMail,
              nombre_closer: fields.nombreCloser,
            })
            .where(eq(llamadas.id_registro, existing!.id_registro)),
        { label: `${label}/update` },
      );

      console.info(
        `[${label}] Updated closer on record ${existing.id_registro} (estado="${existing.estado}") → closer="${fields.nombreCloser}" <${fields.closerMail}>`,
      );

      return {
        success: true,
        data: {
          id_registro: existing.id_registro,
          action: "updated",
          estado: existing.estado,
        },
      };
    } catch (err) {
      console.error(`[${label}] Error actualizando registro id=${existing.id_registro}:`, err);
      return { success: false, error: "Database error while updating record" };
    }
  }

  try {
    const [inserted] = await withRetry(
      () =>
        drizzleDb
          .insert(llamadas)
          .values({
            fecha_evento: new Date(),
            id_cuenta: idCuenta,
            nombre_lead: "sin nombre",
            estado: "pdte",
            closer_mail: fields.closerMail,
            nombre_closer: fields.nombreCloser,
            intentos_contacto: 0,
            id_user_ghl: fields.idUserGhl,
          })
          .returning({ id_registro: llamadas.id_registro }),
      { label: `${label}/insert` },
    );

    const idRegistro = inserted?.id_registro ?? null;

    console.info(
      `[${label}] Created new record ${idRegistro} for idUserGhl="${fields.idUserGhl}" → closer="${fields.nombreCloser}" <${fields.closerMail}>`,
    );

    return {
      success: true,
      data: {
        id_registro: idRegistro,
        action: "created",
        estado: "pdte",
      },
    };
  } catch (err) {
    console.error(`[${label}] Error insertando nuevo registro:`, err);
    return { success: false, error: "Database error while inserting new record" };
  }
}

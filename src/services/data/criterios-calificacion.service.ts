/**
 * Servicio para leer y actualizar criterios_calificacion de una cuenta.
 *
 * AUT-413: criterios de calificación configurables por cuenta.
 */

import { drizzleDb } from "../../config/drizzle.js";
import { cuentas } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import {
  parseCriteriosCalificacion,
  type CriteriosCalificacion,
} from "./criterios-calificacion.utils.js";

// Re-export types and pure utils so callers only need one import
export { parseCriteriosCalificacion, esCalificado, resolverCriterios } from "./criterios-calificacion.utils.js";
export type { CriteriosCalificacion, CriteriosCanal, Canal, CategoriaCustom } from "./criterios-calificacion.utils.js";

// ─── Operaciones de BD ────────────────────────────────────────────────────────

export async function getCriteriosCalificacion(
  idCuenta: number,
): Promise<CriteriosCalificacion | null> {
  const [row] = await drizzleDb
    .select({ criterios_calificacion: cuentas.criterios_calificacion })
    .from(cuentas)
    .where(eq(cuentas.id_cuenta, idCuenta))
    .limit(1);

  if (!row) {
    throw new Error(`Cuenta ${idCuenta} no encontrada`);
  }

  const raw = row.criterios_calificacion;
  if (raw === null || raw === undefined) return null;

  // Parsear y validar lo que hay en BD (defensa en profundidad)
  try {
    return parseCriteriosCalificacion(raw);
  } catch {
    return null;
  }
}

export async function updateCriteriosCalificacion(
  idCuenta: number,
  criterios: CriteriosCalificacion | null,
): Promise<CriteriosCalificacion | null> {
  const result = await drizzleDb
    .update(cuentas)
    .set({ criterios_calificacion: criterios as unknown as Record<string, unknown> })
    .where(eq(cuentas.id_cuenta, idCuenta))
    .returning({ criterios_calificacion: cuentas.criterios_calificacion });

  if (result.length === 0) {
    throw new Error(`Cuenta ${idCuenta} no encontrada`);
  }

  const raw = result[0].criterios_calificacion;
  if (raw === null || raw === undefined) return null;

  try {
    return parseCriteriosCalificacion(raw);
  } catch {
    return null;
  }
}

import { drizzleDb } from "../../config/drizzle.js";
import { cuentas } from "../../db/schema.js";
import { eq } from "drizzle-orm";

export function parseEtiquetasDescarte(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error("etiquetas_descarte debe ser un array de strings");
  }
  for (const item of raw) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error("Cada etiqueta debe ser un string no vacío");
    }
  }
  const unique = [...new Set(raw.map((s: string) => s.trim().toLowerCase()))];
  if (unique.length === 0) {
    throw new Error("Debe haber al menos una etiqueta de descarte");
  }
  return unique;
}

export async function getEtiquetasDescarte(
  idCuenta: number,
): Promise<string[] | null> {
  const [row] = await drizzleDb
    .select({ etiquetas_descarte: cuentas.etiquetas_descarte })
    .from(cuentas)
    .where(eq(cuentas.id_cuenta, idCuenta))
    .limit(1);

  if (!row) throw new Error(`Cuenta ${idCuenta} no encontrada`);

  const raw = row.etiquetas_descarte;
  if (raw === null || raw === undefined) return null;

  try {
    return parseEtiquetasDescarte(raw);
  } catch {
    return null;
  }
}

export async function updateEtiquetasDescarte(
  idCuenta: number,
  etiquetas: string[] | null,
): Promise<string[] | null> {
  const result = await drizzleDb
    .update(cuentas)
    .set({ etiquetas_descarte: etiquetas as unknown as Record<string, unknown> })
    .where(eq(cuentas.id_cuenta, idCuenta))
    .returning({ etiquetas_descarte: cuentas.etiquetas_descarte });

  if (result.length === 0) throw new Error(`Cuenta ${idCuenta} no encontrada`);

  const raw = result[0].etiquetas_descarte;
  if (raw === null || raw === undefined) return null;

  try {
    return parseEtiquetasDescarte(raw);
  } catch {
    return null;
  }
}

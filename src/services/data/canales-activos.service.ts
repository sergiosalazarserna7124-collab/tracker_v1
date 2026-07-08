import { drizzleDb } from "../../config/drizzle.js";
import { cuentas } from "../../db/schema.js";
import { eq } from "drizzle-orm";

export interface CanalesActivos {
  chats: boolean;
  llamadas: boolean;
  videollamadas: boolean;
}

export function parseCanalesActivos(raw: unknown): CanalesActivos {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("canales_activos debe ser un objeto");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.chats !== "boolean") throw new Error("chats debe ser boolean");
  if (typeof obj.llamadas !== "boolean") throw new Error("llamadas debe ser boolean");
  if (typeof obj.videollamadas !== "boolean") throw new Error("videollamadas debe ser boolean");
  return { chats: obj.chats, llamadas: obj.llamadas, videollamadas: obj.videollamadas };
}

export async function getCanalesActivos(
  idCuenta: number,
): Promise<CanalesActivos | null> {
  const [row] = await drizzleDb
    .select({ canales_activos: cuentas.canales_activos })
    .from(cuentas)
    .where(eq(cuentas.id_cuenta, idCuenta))
    .limit(1);

  if (!row) throw new Error(`Cuenta ${idCuenta} no encontrada`);

  const raw = row.canales_activos;
  if (raw === null || raw === undefined) return null;

  try {
    return parseCanalesActivos(raw);
  } catch {
    return null;
  }
}

export async function updateCanalesActivos(
  idCuenta: number,
  canales: CanalesActivos | null,
): Promise<CanalesActivos | null> {
  const result = await drizzleDb
    .update(cuentas)
    .set({ canales_activos: canales as unknown as Record<string, unknown> })
    .where(eq(cuentas.id_cuenta, idCuenta))
    .returning({ canales_activos: cuentas.canales_activos });

  if (result.length === 0) throw new Error(`Cuenta ${idCuenta} no encontrada`);

  const raw = result[0].canales_activos;
  if (raw === null || raw === undefined) return null;

  try {
    return parseCanalesActivos(raw);
  } catch {
    return null;
  }
}

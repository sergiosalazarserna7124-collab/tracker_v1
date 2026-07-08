import { sql } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { usoApiMensual } from "../../db/schema.js";

// ─── Tipos de consumo ─────────────────────────────────────────────────────────
export const TIPO_CONSUMO = {
  GPT4O_MINI: "gpt4o_mini",
  WHISPER: "whisper",
  GEMINI_FLASH: "gemini_flash",
} as const;

function getMesAnio(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Registra consumo de API de IA por tenant en uso_api_mensual.
 * Hace UPSERT acumulando cantidad. Fire-and-forget: los errores se loggean
 * pero nunca se propagan para no interrumpir el pipeline principal.
 */
export async function trackApiUsage(
  idCuenta: number | null | undefined,
  tipoConsumo: string,
  cantidad: number,
): Promise<void> {
  if (!idCuenta || cantidad <= 0) return;
  try {
    await drizzleDb
      .insert(usoApiMensual)
      .values({
        id_cuenta: idCuenta,
        mes_anio: getMesAnio(),
        tipo_consumo: tipoConsumo,
        cantidad,
      })
      .onConflictDoUpdate({
        target: [usoApiMensual.id_cuenta, usoApiMensual.mes_anio, usoApiMensual.tipo_consumo],
        set: {
          cantidad: sql`COALESCE(${usoApiMensual.cantidad}, 0) + ${cantidad}`,
        },
      });
  } catch (err) {
    console.error(
      `[trackApiUsage] Error tracking ${tipoConsumo} para cuenta ${idCuenta}:`,
      err,
    );
  }
}

import { eq, and, sql } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { kpisExternos, usoApiMensual } from "../../db/schema.js";
import type { MetricaItemType } from "../../schemas/webhooks/external-data.schema.js";

export async function processExternalData(
  idCuenta: number,
  data: MetricaItemType[],
): Promise<{ processed: number }> {
  let processed = 0;

  // Fecha de hoy en UTC como fallback si el payload no incluye fecha
  const todayUtc = new Date().toISOString().slice(0, 10);

  for (const item of data) {
    const origen = item.origen ?? "api_externa";
    const fecha = item.fecha ?? todayUtc;

    const [existing] = await drizzleDb
      .select({ id_registro: kpisExternos.id_registro })
      .from(kpisExternos)
      .where(
        and(
          eq(kpisExternos.id_cuenta, idCuenta),
          eq(kpisExternos.fecha, fecha),
        ),
      )
      .limit(1);

    if (existing) {
      await drizzleDb
        .update(kpisExternos)
        .set({ metricas: item.metricas, origen })
        .where(eq(kpisExternos.id_registro, existing.id_registro));
    } else {
      await drizzleDb.insert(kpisExternos).values({
        id_cuenta: idCuenta,
        fecha,
        origen,
        metricas: item.metricas,
      });
    }

    processed++;
  }

  const mesAnio = new Date().toISOString().slice(0, 7);

  await drizzleDb
    .insert(usoApiMensual)
    .values({
      id_cuenta: idCuenta,
      mes_anio: mesAnio,
      tipo_consumo: "webhook_externo",
      cantidad: processed,
    })
    .onConflictDoUpdate({
      target: [usoApiMensual.id_cuenta, usoApiMensual.mes_anio, usoApiMensual.tipo_consumo],
      set: { cantidad: sql`${usoApiMensual.cantidad} + ${processed}` },
    });

  return { processed };
}

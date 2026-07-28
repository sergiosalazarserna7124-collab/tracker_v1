import { sql, eq, and, or } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { cuentas } from "../../db/schema.js";

interface UpsertResult {
  processed: number;
  campos_guardados: string[];
  fecha: string;
  atribuido_a: { userId: string; customerId: string | null } | null;
}

export async function resolveAccountByLocation(
  locationId: string,
): Promise<{ id_cuenta: number; zona_horaria_iana: string | null } | null> {
  const isNumeric = /^\d+$/.test(locationId);

  const conditions = [
    eq(cuentas.locationid, locationId),
  ];
  if (isNumeric) {
    conditions.unshift(eq(cuentas.id_cuenta, Number(locationId)));
  }

  const [row] = await drizzleDb
    .select({
      id_cuenta: cuentas.id_cuenta,
      zona_horaria_iana: cuentas.zona_horaria_iana,
    })
    .from(cuentas)
    .where(or(...conditions)!)
    .limit(1);

  return row ?? null;
}

export async function upsertMetricasWebhook(
  idCuenta: number,
  zonaHoraria: string | null,
  body: Record<string, unknown>,
): Promise<UpsertResult> {
  const rawUserId = body.userId ?? body.asesor ?? body.correo;
  const ghlUserId =
    typeof rawUserId === "string" && rawUserId.trim()
      ? rawUserId.trim()
      : null;
  const ghlCustomerId =
    typeof body.customerId === "string" && body.customerId.trim()
      ? body.customerId.trim()
      : null;

  let fecha: string;
  const fechaRaw = body.fecha as string | undefined;
  if (fechaRaw) {
    if (fechaRaw.includes("T") || fechaRaw.includes(" ")) {
      const d = new Date(fechaRaw);
      fecha = isNaN(d.getTime())
        ? new Date().toISOString().slice(0, 10)
        : d.toISOString().slice(0, 10);
    } else {
      fecha = fechaRaw.slice(0, 10);
    }
  } else {
    const tz = zonaHoraria ?? "UTC";
    try {
      fecha = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(
        new Date(),
      );
    } catch {
      fecha = new Date().toISOString().slice(0, 10);
    }
  }

  const reserved = new Set(["userId", "customerId", "fecha", "asesor", "correo"]);
  const campos_guardados: string[] = [];

  for (const [campo, valor] of Object.entries(body)) {
    if (reserved.has(campo)) continue;
    const num = Number(valor);
    if (isNaN(num) || typeof valor === "object") continue;

    if (ghlUserId !== null || ghlCustomerId !== null) {
      await drizzleDb.execute(sql`
        INSERT INTO metricas_webhook (id_cuenta, fecha, campo, valor, ghl_user_id, ghl_customer_id, updated_at)
        VALUES (${idCuenta}, ${fecha}, ${campo}, ${String(num)}, ${ghlUserId}, ${ghlCustomerId}, NOW())
        ON CONFLICT (id_cuenta, fecha, campo, ghl_user_id) DO UPDATE
        SET valor = metricas_webhook.valor + ${String(num)},
            ghl_customer_id = EXCLUDED.ghl_customer_id,
            updated_at = NOW()
      `);
      await drizzleDb.execute(sql`
        INSERT INTO metricas_webhook (id_cuenta, fecha, campo, valor, ghl_user_id, updated_at)
        VALUES (${idCuenta}, ${fecha}, ${campo}, ${String(num)}, NULL, NOW())
        ON CONFLICT (id_cuenta, fecha, campo) WHERE ghl_user_id IS NULL DO UPDATE
        SET valor = metricas_webhook.valor + ${String(num)},
            updated_at = NOW()
      `);
    } else {
      await drizzleDb.execute(sql`
        INSERT INTO metricas_webhook (id_cuenta, fecha, campo, valor, ghl_user_id, updated_at)
        VALUES (${idCuenta}, ${fecha}, ${campo}, ${String(num)}, NULL, NOW())
        ON CONFLICT (id_cuenta, fecha, campo) WHERE ghl_user_id IS NULL DO UPDATE
        SET valor = ${String(num)},
            updated_at = NOW()
      `);
    }

    campos_guardados.push(campo);
  }

  return {
    processed: campos_guardados.length,
    campos_guardados,
    fecha,
    atribuido_a: ghlUserId
      ? { userId: ghlUserId, customerId: ghlCustomerId }
      : null,
  };
}

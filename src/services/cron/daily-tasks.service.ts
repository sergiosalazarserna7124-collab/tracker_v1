import { eq, and, inArray, sql, lt } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { agendas, cuentas, llamadas } from "../../db/schema.js";
import { addContactTag } from "../ghl-api.service.js";
import { processInChunks } from "../../utils/batch.utils.js";
import { withRetry } from "../../utils/retry.utils.js";

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface UpdateNoShowsInput {
  target_date: string;
  account_ids: number[];
}

interface UpdateNoShowsResult {
  success: boolean;
  target_date: string;
  processed_count: number;
  updated_ids: number[];
  tagged_count: number;
  reglas_aplicadas?: number;
}

interface EmbudoEtapaMinimal {
  id: string;
  nombre: string;
  reglas_automaticas?: Array<{ evento: string; valor?: number }>;
}

// ─── Lógica principal ─────────────────────────────────────────────────────────

export async function updateNoShows(input: UpdateNoShowsInput): Promise<UpdateNoShowsResult> {
  const { target_date, account_ids } = input;

  // ── 1. Batch UPDATE con Drizzle ──────────────────────────────────────────────
  // Condiciones:
  //   - id_cuenta está en el array recibido
  //   - la fecha de la reunión (casteada a date) coincide con target_date
  //   - la categoría actual es PDTE (solo marcamos no-shows de citas pendientes)
  // Acciones:
  //   - categoria → 'no_show'
  //   - tags: concatena ',noshowautoia' (o lo pone como primer tag si está vacío)

  const updated = await withRetry(
    () =>
      drizzleDb
        .update(agendas)
        .set({
          categoria: "no_show",
          tags: sql<string>`
            CASE
              WHEN ${agendas.tags} IS NULL OR ${agendas.tags} = ''
              THEN 'noshowautoia'
              ELSE ${agendas.tags} || ',noshowautoia'
            END
          `,
        })
        .where(
          and(
            inArray(agendas.id_cuenta, account_ids),
            sql`CAST(${agendas.fechaReunion} AS date) = ${target_date}::date`,
            eq(agendas.categoria, "PDTE"),
          ),
        )
        .returning({
          id_registro_agenda: agendas.id_registro_agenda,
          id_cuenta: agendas.id_cuenta,
          ghl_contact_id: agendas.ghl_contact_id,
        }),
    { label: "updateNoShows/batchUpdate" },
  );

  if (updated.length === 0) {
    // Aun si no hay nuevos no-shows, aplicar reglas automáticas en las cuentas
    const reglasCount = await applyReglaAutomaticaAllAccounts(account_ids);
    return {
      success: true,
      target_date,
      processed_count: 0,
      updated_ids: [],
      tagged_count: 0,
      reglas_aplicadas: reglasCount,
    };
  }

  // ── 2. Obtener tokens GHL de las cuentas afectadas ───────────────────────────

  const uniqueAccountIds = [...new Set(updated.map((r) => r.id_cuenta))];

  const accountRows = await withRetry(
    () =>
      drizzleDb
        .select({ id_cuenta: cuentas.id_cuenta, token_ghl: cuentas.token_ghl })
        .from(cuentas)
        .where(inArray(cuentas.id_cuenta, uniqueAccountIds)),
    { label: "updateNoShows/getTokens" },
  );

  const tokenByAccount = new Map(
    accountRows
      .filter((a) => a.token_ghl !== null)
      .map((a) => [a.id_cuenta, a.token_ghl as string]),
  );

  // ── 3. Push tag 'noshowautoia' a GHL con rate limiting ───────────────────────
  // Procesa en lotes de 10 con 500ms de pausa entre lotes para respetar
  // el rate limit de GHL y evitar errores 429 Too Many Requests.
  // Los errores individuales se capturan para no abortar el batch completo.

  const contactsToTag = updated.filter(
    (r) => r.ghl_contact_id !== null && tokenByAccount.has(r.id_cuenta),
  );

  const tagResults = await processInChunks(
    contactsToTag,
    10,
    500,
    (r) =>
      addContactTag(r.ghl_contact_id as string, tokenByAccount.get(r.id_cuenta)!, "noshowautoia")
        .then(() => true)
        .catch((err: unknown) => {
          console.error(
            `[Cron no-show] Tag fallido contacto=${r.ghl_contact_id} cuenta=${r.id_cuenta}:`,
            err,
          );
          return false;
        }),
  );

  const tagged_count = tagResults.filter(Boolean).length;

  // ── 4. Aplicar reglas_automaticas del embudo personalizado ──────────────────
  const reglasCount = await applyReglaAutomaticaAllAccounts(account_ids);

  return {
    success: true,
    target_date,
    processed_count: updated.length,
    updated_ids: updated.map((r) => r.id_registro_agenda),
    tagged_count,
    reglas_aplicadas: reglasCount,
  };
}

// ─── Reglas automáticas del embudo ────────────────────────────────────────────

/**
 * Aplica reglas_automaticas definidas en el embudo personalizado de cada cuenta.
 * Para cada etapa con reglas, mueve los leads correspondientes a esa etapa.
 * Reglas soportadas:
 *   - no_show: leads con categoria='no_show' → mover a esta etapa
 *   - cancelada: leads con categoria='cancelada' → mover a esta etapa
 *   - sin_actividad_dias: leads cuya última actividad supera N días → mover a esta etapa
 */
async function applyReglaAutomaticaAllAccounts(account_ids: number[]): Promise<number> {
  if (account_ids.length === 0) return 0;

  let totalMoved = 0;

  // Obtener cuentas con su embudo personalizado
  const cuentaRows = await withRetry(
    () =>
      drizzleDb
        .select({
          id_cuenta: cuentas.id_cuenta,
          embudo_personalizado: cuentas.embudo_personalizado,
          token_ghl: cuentas.token_ghl,
          locationid: cuentas.locationid,
        })
        .from(cuentas)
        .where(inArray(cuentas.id_cuenta, account_ids)),
    { label: "applyReglas/getCuentas" },
  );

  for (const cuenta of cuentaRows) {
    const embudo = cuenta.embudo_personalizado as EmbudoEtapaMinimal[] | null;
    if (!Array.isArray(embudo) || embudo.length === 0) continue;

    try {
      const moved = await applyReglaAutomaticaForCuenta(
        cuenta.id_cuenta,
        embudo,
        cuenta.token_ghl,
        cuenta.locationid,
      );
      totalMoved += moved;
    } catch (err) {
      console.error(`[Cron reglas] Error procesando cuenta=${cuenta.id_cuenta}:`, err);
    }
  }

  return totalMoved;
}

async function applyReglaAutomaticaForCuenta(
  idCuenta: number,
  embudo: EmbudoEtapaMinimal[],
  _tokenGhl: string | null,
  _locationId: string | null,
): Promise<number> {
  let moved = 0;

  for (const etapa of embudo) {
    const reglas = etapa.reglas_automaticas ?? [];
    if (reglas.length === 0) continue;

    const etapaLabel = etapa.nombre ?? etapa.id;

    for (const regla of reglas) {
      try {
        if (regla.evento === "no_show" || regla.evento === "cancelada") {
          // Mover leads con esa categoria a esta etapa del embudo
          const result = await withRetry(
            () =>
              drizzleDb
                .update(agendas)
                .set({ categoria: etapaLabel })
                .where(
                  and(
                    eq(agendas.id_cuenta, idCuenta),
                    eq(agendas.categoria, regla.evento),
                  ),
                )
                .returning({ id: agendas.id_registro_agenda }),
            { label: `applyReglas/${regla.evento}/update` },
          );
          if (result.length > 0) {
            console.info(
              `[Cron reglas] cuenta=${idCuenta} evento=${regla.evento} → etapa="${etapaLabel}" (${result.length} agendas)`,
            );
            moved += result.length;
          }
        } else if (regla.evento === "sin_actividad_dias" && regla.valor && regla.valor > 0) {
          // Buscar leads en registros_de_llamada cuya última actividad supera N días
          // y moverlos a esta etapa
          const diasLimite = regla.valor;
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - diasLimite);

          const result = await withRetry(
            () =>
              drizzleDb
                .update(llamadas)
                .set({
                  estado: etapaLabel,
                })
                .where(
                  and(
                    eq(llamadas.id_cuenta, idCuenta),
                    lt(llamadas.fecha_y_hora_de_seguimiento, cutoffDate),
                    // Solo mover leads que estén en etapas activas (no cerradas)
                    sql`${llamadas.estado} NOT IN ('cerrado', 'ganado', 'perdido', ${etapaLabel})`,
                  ),
                )
                .returning({ id: llamadas.id_registro }),
            { label: `applyReglas/sin_actividad_dias/update` },
          );
          if (result.length > 0) {
            console.info(
              `[Cron reglas] cuenta=${idCuenta} sin_actividad_dias=${diasLimite} → etapa="${etapaLabel}" (${result.length} llamadas)`,
            );
            moved += result.length;
          }
        }
      } catch (err) {
        console.error(
          `[Cron reglas] Error en regla evento=${regla.evento} etapa="${etapaLabel}" cuenta=${idCuenta}:`,
          err,
        );
      }
    }
  }

  return moved;
}

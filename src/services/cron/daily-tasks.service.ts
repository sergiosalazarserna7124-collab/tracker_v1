import { eq, and, inArray, sql } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { agendas, cuentas } from "../../db/schema.js";
import { addContactTag } from "../ghl-api.service.js";
import { processInChunks } from "../../utils/batch.utils.js";

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

  const updated = await drizzleDb
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
    });

  if (updated.length === 0) {
    return {
      success: true,
      target_date,
      processed_count: 0,
      updated_ids: [],
      tagged_count: 0,
    };
  }

  // ── 2. Obtener tokens GHL de las cuentas afectadas ───────────────────────────

  const uniqueAccountIds = [...new Set(updated.map((r) => r.id_cuenta))];

  const accountRows = await drizzleDb
    .select({ id_cuenta: cuentas.id_cuenta, token_ghl: cuentas.token_ghl })
    .from(cuentas)
    .where(inArray(cuentas.id_cuenta, uniqueAccountIds));

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

  return {
    success: true,
    target_date,
    processed_count: updated.length,
    updated_ids: updated.map((r) => r.id_registro_agenda),
    tagged_count,
  };
}

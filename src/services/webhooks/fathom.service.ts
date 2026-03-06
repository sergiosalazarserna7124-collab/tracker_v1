import { eq, and, desc } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { agendas, cuentas, eventosHuerfanos } from "../../db/schema.js";
import {
  addContactTag,
  addContactTags,
  addContactNote,
  searchContactByEmail,
  getGhlUser,
  GHL_TAGS,
} from "../ghl-api.service.js";
import { analyzeCall } from "../ai/call-analysis.service.js";
import { withRetry } from "../../utils/retry.utils.js";
import type { FathomEventBody } from "../../schemas/webhooks/fathom.schema.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTranscript(
  transcript: FathomEventBody["transcript"],
): string {
  if (!transcript?.length) return "";
  return transcript
    .map((t) => `${t.speaker?.display_name ?? "Unknown"}: ${t.text}`)
    .join("\n");
}

/**
 * Mapea la categoría devuelta por el clasificador IA al nombre del tag de GHL.
 */
function categoriaToGhlTag(
  categoria: string,
): string {
  const map: Record<string, string> = {
    Cerrada: GHL_TAGS.cerrada,
    Ofertada: GHL_TAGS.ofertada,
    No_Ofertada: GHL_TAGS.noofertada,
  };
  return map[categoria] ?? GHL_TAGS.noofertada;
}

// ─── Función principal ────────────────────────────────────────────────────────

export async function processFathomCall(
  idCuenta: number,
  payload: FathomEventBody,
): Promise<void> {
  // ── Fase 1: Data Prep (síncrono) ──────────────────────────────────────────

  const closerName = payload.recorded_by?.name ?? null;
  const closerEmail = payload.recorded_by?.email ?? null;
  // closerName se usa como fallback si GHL no tiene un assignedUserId
  const shareUrl = payload.share_url ?? payload.url ?? null;

  // Formatear transcripción para el prompt de IA
  const formattedTranscript = formatTranscript(payload.transcript);

  // Encontrar invitados externos (is_external y email distinto al creador)
  const externalInvitees = (payload.calendar_invitees ?? []).filter(
    (inv) => inv.is_external === true && inv.email !== closerEmail,
  );

  // ── Fase 2: Obtener datos de la cuenta ────────────────────────────────────

  let account: {
    token_ghl: string | null;
    locationid: string | null;
    prompt_ventas: string | null;
    prompt_videollamadas: string | null;
    openai_api_key: string | null;
    embudo_personalizado: unknown;
    reglas_etiquetas: unknown;
  } | null = null;

  try {
    const rows = await withRetry(
      () =>
        drizzleDb
          .select({
            token_ghl: cuentas.token_ghl,
            locationid: cuentas.locationid,
            prompt_ventas: cuentas.prompt_ventas,
            prompt_videollamadas: cuentas.prompt_videollamadas,
            openai_api_key: cuentas.openai_api_key,
            embudo_personalizado: cuentas.embudo_personalizado,
            reglas_etiquetas: cuentas.reglas_etiquetas,
          })
          .from(cuentas)
          .where(eq(cuentas.id_cuenta, idCuenta))
          .limit(1),
      { label: "Fathom/getAccount" },
    );

    account = rows[0] ?? null;
  } catch (err) {
    console.error(`[Fathom] Error fetching account ${idCuenta}:`, err);
  }

  if (!account) {
    console.warn(`[Fathom] Account ${idCuenta} not found. Saving as orphan.`);
    try {
      await drizzleDb.insert(eventosHuerfanos).values({
        id_cuenta: idCuenta,
        origen: "fathom",
        motivo: `Cuenta ${idCuenta} no encontrada en la BD`,
        payload_original: payload,
        estado: "pendiente",
      });
    } catch (orphanErr) {
      console.error("[Fathom] Error guardando evento huérfano:", orphanErr);
    }
    return;
  }

  if (!account.token_ghl || !account.locationid) {
    console.warn(
      `[Fathom] Account ${idCuenta} missing token_ghl or locationid. Some steps will be skipped.`,
    );
  }

  // ── Fase 3: Buscar contacto en GHL + identificar email_lead ──────────────

  let emailLead: string | null = null;
  let contactId: string | null = null;
  let contactName: string | null = null;
  let utmContent: string | null = null;
  let closerEmailFromGhl: string | null = null;

  // Si hay múltiples invitados externos, iterar hasta encontrar uno con registro en BD
  if (externalInvitees.length > 0 && account.token_ghl && account.locationid) {
    for (const invitee of externalInvitees) {
      try {
        const contact = await searchContactByEmail(
          account.locationid,
          invitee.email,
          account.token_ghl,
        );

        if (contact) {
          emailLead = invitee.email;
          contactId = contact.id;
          contactName = [contact.firstName, contact.lastName]
            .filter(Boolean)
            .join(" ") || null;
          utmContent = contact.utmContent;

          // Obtener email del closer asignado si existe
          if (contact.assignedTo) {
            try {
              const ghlUser = await getGhlUser(
                contact.assignedTo,
                account.token_ghl,
              );
              closerEmailFromGhl = ghlUser?.email ?? null;
            } catch (err) {
              console.warn(
                `[Fathom] Could not fetch GHL user ${contact.assignedTo}:`,
                err,
              );
            }
          }
          break; // Encontrado → salir del loop
        }
      } catch (err) {
        console.warn(
          `[Fathom] GHL search failed for ${invitee.email}:`,
          err,
        );
      }
    }

    // Fallback: usar el primer invitado externo si ninguno tuvo match en GHL
    if (!emailLead) {
      emailLead = externalInvitees[0]?.email ?? null;
    }
  } else if (externalInvitees.length > 0) {
    // Sin token GHL disponible, usar el primer externo directamente
    emailLead = externalInvitees[0]?.email ?? null;
  }

  if (!emailLead) {
    console.warn(`[Fathom] Could not determine email_lead for call ${shareUrl}. Saving as orphan.`);
    try {
      await drizzleDb.insert(eventosHuerfanos).values({
        id_cuenta: idCuenta,
        origen: "fathom",
        motivo: "Email no encontrado en el payload (sin invitados externos o sin match en GHL)",
        payload_original: payload,
        estado: "pendiente",
      });
    } catch (orphanErr) {
      console.error("[Fathom] Error guardando evento huérfano:", orphanErr);
    }
    return;
  }

  // ── Fase 4: Motor IA en paralelo ─────────────────────────────────────────

  let aiResult: Awaited<ReturnType<typeof analyzeCall>> | null = null;

  try {
    if (formattedTranscript) {
      aiResult = await analyzeCall(
        formattedTranscript,
        account.prompt_ventas,
        account.prompt_videollamadas,
        account.openai_api_key,
        account.embudo_personalizado,
        account.reglas_etiquetas,
      );
    } else {
      console.warn(`[Fathom] Empty transcript for call ${shareUrl}. Skipping AI analysis.`);
    }
  } catch (err) {
    console.error(`[Fathom] AI analysis error for call ${shareUrl}:`, err);
  }

  const classifier = aiResult?.classifier ?? null;
  const analysisText = aiResult?.analysisText ?? null;
  const objections = aiResult?.objections ?? null;
  const reglasResult = aiResult?.reglasResult ?? { matched_tags: [], matched_rules: [] };
  const tagsInternos = reglasResult.matched_tags;

  // ── Fase 5: Sync final (GHL tag + DB update) ─────────────────────────────

  // 5a. Aplicar tag de clasificación en GHL
  if (contactId && account.token_ghl && classifier) {
    try {
      const tag = categoriaToGhlTag(classifier.categoria);
      await addContactTag(contactId, account.token_ghl, tag);
    } catch (err) {
      console.error(
        `[Fathom] GHL tag error for contact ${contactId}:`,
        err,
      );
    }
  }

  // 5a-bis. Aplicar tags de reglas_etiquetas en GHL
  if (contactId && account.token_ghl && tagsInternos.length > 0) {
    try {
      await addContactTags(contactId, account.token_ghl, tagsInternos);
    } catch (err) {
      console.error(
        `[Fathom] GHL reglas tags error for contact ${contactId}:`,
        err,
      );
    }
  }

  // 5b. Upsert en resumenes_diarios_agendas:
  //   - Si ya existe registro (GHL agendó la cita): UPDATE con datos de IA.
  //   - Si NO existe (videollamada sin cita previa en GHL): INSERT completo.
  try {
    const [existing] = await withRetry(
      () =>
        drizzleDb
          .select({ id: agendas.id_registro_agenda })
          .from(agendas)
          .where(
            and(
              eq(agendas.email_lead, emailLead),
              eq(agendas.id_cuenta, idCuenta),
            ),
          )
          .orderBy(desc(agendas.fecha))
          .limit(1),
      { label: "Fathom/findExisting" },
    );

    if (existing) {
      // ── UPDATE: registro previo encontrado ───────────────────────────────
      // link_llamada siempre se incluye para garantizar que el objeto .set()
      // nunca quede vacío (Drizzle lanza error con {}).
      await withRetry(
        () =>
          drizzleDb
            .update(agendas)
            .set({
              link_llamada: shareUrl,
              ...(classifier && {
                categoria: classifier.categoria,
                cash_collected: classifier.cash_collected,
                facturacion: classifier.facturacion,
              }),
              ...(analysisText && { resumen_ia: analysisText }),
              ...(objections && { objeciones_ia: objections }),
              tags_internos: tagsInternos,
              ...(utmContent && { origen: utmContent }),
              ...(contactId && { ghl_contact_id: contactId }),
              ...(contactName && { nombre_de_lead: contactName }),
              ...(closerEmailFromGhl
                ? { closer: closerEmailFromGhl }
                : closerName
                  ? { closer: closerName }
                  : {}),
            })
            .where(eq(agendas.id_registro_agenda, existing.id)),
        { label: "Fathom/updateAgenda" },
      );

      console.info(
        `[Fathom] Updated agenda record ${existing.id} for id_cuenta=${idCuenta}, email=${emailLead}, categoria=${classifier?.categoria ?? "N/A"}`,
      );
    } else {
      // ── INSERT: sin registro previo (videollamada sin cita en GHL) ───────
      const now = new Date();

      await withRetry(
        () =>
          drizzleDb.insert(agendas).values({
            id_cuenta: idCuenta,
            email_lead: emailLead,
            fecha: now,
            fechaReunion: now,
            nombre_de_lead: contactName,
            origen: utmContent,
            ghl_contact_id: contactId,
            closer: closerEmailFromGhl ?? closerName ?? null,
            link_llamada: shareUrl,
            ...(classifier && {
              categoria: classifier.categoria,
              cash_collected: classifier.cash_collected,
              facturacion: classifier.facturacion,
            }),
            ...(analysisText && { resumen_ia: analysisText }),
            ...(objections && { objeciones_ia: objections }),
            tags_internos: tagsInternos,
          }),
        { label: "Fathom/insertAgenda" },
      );

      console.info(
        `[Fathom] Inserted new agenda record for id_cuenta=${idCuenta}, email=${emailLead}, categoria=${classifier?.categoria ?? "N/A"}`,
      );
    }
  } catch (err) {
    console.error(
      `[Fathom] DB upsert error for email=${emailLead}, id_cuenta=${idCuenta}:`,
      err,
    );
  }

  // ── Fase 6: Notas GHL (transcripción + análisis IA) ─────────────────────
  if (contactId && account.token_ghl) {
    const aiSummary = [
      classifier ? `Categoría: ${classifier.categoria}` : null,
      classifier?.cash_collected && classifier.cash_collected !== "0"
        ? `Cash collected: ${classifier.cash_collected}`
        : null,
      classifier?.facturacion && classifier.facturacion !== "0"
        ? `Facturación: ${classifier.facturacion}`
        : null,
      analysisText ? `\n${analysisText}` : null,
      tagsInternos.length > 0 ? `\nEtiquetas: ${tagsInternos.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    if (aiSummary) {
      try {
        await addContactNote(
          contactId,
          account.token_ghl,
          `🎥 Videollamada — Análisis IA\n\n${aiSummary}`,
        );
      } catch (err) {
        console.error(`[Fathom] Error agregando nota IA en GHL:`, err);
      }
    }

    if (formattedTranscript) {
      try {
        await addContactNote(
          contactId,
          account.token_ghl,
          `🎥 Videollamada — Transcripción\n\n${formattedTranscript}`,
        );
      } catch (err) {
        console.error(`[Fathom] Error agregando nota transcripción en GHL:`, err);
      }
    }
  }
}

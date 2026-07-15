import { eq, and, or, desc, sql } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { db as pgPool } from "../../config/database.js";
import { agendas, cuentas, eventosHuerfanos, logLlamadas } from "../../db/schema.js";
import {
  addContactNote,
  searchContactByEmail,
  getGhlUser,
  getContactAppointmentInfo,
  safeAddContactTag,
  safeAddContactTags,
  removeContactTag,
  searchOpportunityByContact,
  updateOpportunityStage,
  createContactTask,
  updateContactCustomFields,
  parseFunnelStageMap,
  GHL_TAGS,
} from "../ghl-api.service.js";
import { analyzeCall } from "../ai/call-analysis.service.js";
import { extractCitaTarea, type CitaTareaExtraction } from "../ai/cita-tarea-extraction.service.js";
import { applyReglasMetricActions, collectFunnelStages } from "../ai/reglas-actions.service.js";
import { applyMergeRules } from "../ai/closer-dedup.service.js";
import { enrichWithGemini, estimateDurationFromTranscript } from "../ai/gemini-enrichment.service.js";
import { withRetry } from "../../utils/retry.utils.js";
import type { FathomEventBody } from "../../schemas/webhooks/fathom.schema.js";

interface ProcessFathomCallOptions {
  ingestionSource?: "webhook" | "quick_recovery" | "orphan_retry";
  allowDuplicateRecordingId?: boolean;
}

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

/**
 * Resuelve la fecha/hora real de la reunión desde el payload de Fathom.
 * Prioriza la hora agendada de inicio y hace fallback a tiempos de grabación.
 */
function resolveMeetingDate(payload: FathomEventBody): Date | null {
  const candidates = [
    payload.scheduled_start_time,
    payload.recording_start_time,
    payload.created_at,
  ];

  for (const value of candidates) {
    if (!value) continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

// ─── Función principal ────────────────────────────────────────────────────────

export async function processFathomCall(
  idCuenta: number,
  payload: FathomEventBody,
  options: ProcessFathomCallOptions = {},
): Promise<void> {
  const ingestionSource = options.ingestionSource ?? "webhook";
  const meetingDate = resolveMeetingDate(payload);

  // ── Fase 1: Data Prep (síncrono) ──────────────────────────────────────────

  const recordingId = payload.recording_id != null
    ? String(payload.recording_id)
    : null;
  const recordedByEmail = payload.recorded_by?.email ?? null;
  const recordedByName = payload.recorded_by?.name ?? null;

  // Resolver el closer real: buscar si el recorded_by.email está registrado como usuario
  // de la cuenta. Si no → puede ser un setter externo (ej: miguel@bluepointrs.com que en
  // la cuenta figura como miguel@serenthys.com). En ese caso buscar en calendar_invitees
  // algún invitado interno que sí esté registrado.
  let closerEmail: string | null = recordedByEmail;
  let closerName: string | null = recordedByName;

  if (recordedByEmail) {
    try {
      const { rows: userRows } = await pgPool.query<{ email: string; nombre_closer: string | null }>(
        `SELECT email, nombre_closer FROM usuarios_dashboard
         WHERE id_cuenta = $1 AND LOWER(TRIM(email)) = LOWER(TRIM($2))
         LIMIT 1`,
        [idCuenta, recordedByEmail],
      );
      if (userRows.length === 0) {
        // recorded_by no es usuario de esta cuenta — puede ser setter externo
        // Buscar en calendar_invitees un invitado interno que sí esté registrado
        const internalInvitees = (payload.calendar_invitees ?? []).filter(i => i.is_external === false);
        for (const inv of internalInvitees) {
          if (!inv.email || inv.email === recordedByEmail) continue;
          const { rows: invUserRows } = await pgPool.query<{ email: string; nombre_closer: string | null }>(
            `SELECT email, nombre_closer FROM usuarios_dashboard
             WHERE id_cuenta = $1 AND LOWER(TRIM(email)) = LOWER(TRIM($2))
             LIMIT 1`,
            [idCuenta, inv.email],
          );
          if (invUserRows.length > 0) {
            closerEmail = invUserRows[0].email;
            closerName = invUserRows[0].nombre_closer ?? inv.name ?? closerName;
            console.info(`[Fathom] recorded_by "${recordedByEmail}" no es usuario de cuenta ${idCuenta} — resuelto como "${closerEmail}" vía calendar_invitees`);
            break;
          }
        }
        if (closerEmail === recordedByEmail) {
          console.warn(`[Fathom] recorded_by "${recordedByEmail}" no es usuario de cuenta ${idCuenta} y no se encontró match en calendar_invitees`);
        }
      }
    } catch (err) {
      console.warn(`[Fathom] Error resolviendo closer para cuenta ${idCuenta}:`, err instanceof Error ? err.message : err);
    }
  }

  // Normalizar closer con merge rules (AUT-273) — graceful: nunca bloquea ingesta
  try {
    const norm = await applyMergeRules(idCuenta, closerEmail, closerName);
    closerEmail = norm.email ?? closerEmail;
    closerName = norm.nombre ?? closerName;
  } catch (err) {
    console.error(`[Fathom] Error aplicando merge rules de closer para cuenta ${idCuenta}:`, err);
  }

  const shareUrl = payload.share_url ?? payload.url ?? null;

  // Formatear transcripción para el prompt de IA
  const formattedTranscript = formatTranscript(payload.transcript);

  // Encontrar invitados externos (is_external y email distinto al creador)
  const externalInvitees = (payload.calendar_invitees ?? []).filter(
    (inv) => inv.is_external === true && inv.email !== closerEmail,
  );

  // Descartar reuniones sin invitados externos — son llamadas internas o reuniones donde el cliente
  // entró por link directo de Zoom (sin invitación de calendario). Sin email externo no podemos
  // identificar al lead ni enlazarlo con GHL. Guardar como huérfano tampoco sirve: no hay dato
  // recuperable.
  const meetingTitle = (payload.meeting_title ?? payload.title ?? "").toLowerCase();
  if (externalInvitees.length === 0) {
    console.info(
      `[Fathom] Skipping meeting with no external invitees recording_id=${recordingId} title="${meetingTitle}" for id_cuenta=${idCuenta} (total_invitees=${(payload.calendar_invitees ?? []).length})`,
    );
    return;
  }

  // Evita reprocesar la misma videollamada para la misma cuenta.
  if (recordingId && !options.allowDuplicateRecordingId) {
    try {
      const [alreadyProcessed] = await withRetry(
        () =>
          drizzleDb
            .select({ id: agendas.id_registro_agenda })
            .from(agendas)
            .where(
              and(
                eq(agendas.id_cuenta, idCuenta),
                eq(agendas.fathom_recording_id, recordingId),
              ),
            )
            .limit(1),
        { label: "Fathom/dedupeByRecordingId" },
      );

      if (alreadyProcessed) {
        console.info(
          `[Fathom] Skipping duplicated recording_id=${recordingId} for id_cuenta=${idCuenta} (agenda=${alreadyProcessed.id})`,
        );
        return;
      }
    } catch (err) {
      console.error(
        `[Fathom] Error checking duplicate recording_id=${recordingId}:`,
        err,
      );
    }
  }

  // ── Fase 2: Obtener datos de la cuenta ────────────────────────────────────

  interface GhlNotasConfig { ia?: boolean; transcripcion?: boolean }
  let account: {
    token_ghl: string | null;
    locationid: string | null;
    prompt_ventas: string | null;
    prompt_videollamadas: string | null;
    openai_api_key: string | null;
    embudo_personalizado: unknown;
    reglas_etiquetas: unknown;
    canales_activos: unknown;
    ghl_native_task_workflow: boolean;
  } | null = null;
  // configuracion_ui no está en el schema Drizzle del Cerebro — se lee via pgPool
  let ghlNotasConfig: GhlNotasConfig = { ia: true, transcripcion: false };

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
            canales_activos: cuentas.canales_activos,
            ghl_native_task_workflow: cuentas.ghl_native_task_workflow,
          })
          .from(cuentas)
          .where(eq(cuentas.id_cuenta, idCuenta))
          .limit(1),
      { label: "Fathom/getAccount" },
    );

    account = rows[0] ?? null;

    // Leer configuracion_ui.ghl_notas (no existe en el schema Drizzle del Cerebro)
    try {
      const cfgRows = await pgPool.query<{ configuracion_ui: { ghl_notas?: GhlNotasConfig } | null }>(
        `SELECT configuracion_ui FROM cuentas WHERE id_cuenta = $1 LIMIT 1`,
        [idCuenta],
      );
      const cfgUi = cfgRows.rows[0]?.configuracion_ui;
      if (cfgUi?.ghl_notas) {
        ghlNotasConfig = {
          ia: cfgUi.ghl_notas.ia !== false,       // default true
          transcripcion: cfgUi.ghl_notas.transcripcion === true, // default false
        };
      }
    } catch (cfgErr) {
      console.warn(`[Fathom] No se pudo leer ghl_notas config para cuenta ${idCuenta}:`, cfgErr);
    }
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

          // Obtener el closer: primero intentar el dueño de la CITA (assignedUserId),
          // que puede ser distinto al dueño del CONTACTO (assignedTo).
          // Sergio confirma que en Serenthys el setter agendó el contacto pero el closer
          // tiene asignada la cita → siempre priorizar appointmentInfo.assignedUserId.
          try {
            const apptInfo = await getContactAppointmentInfo(
              contact.id,
              account.token_ghl,
              new Date(),
            );
            if (apptInfo?.assignedUserId) {
              const apptOwner = await getGhlUser(apptInfo.assignedUserId, account.token_ghl);
              if (apptOwner?.email) {
                closerEmailFromGhl = apptOwner.email;
                console.info(`[Fathom] Closer resuelto desde dueño de CITA: ${closerEmailFromGhl} (contactId=${contact.id})`);
              }
            }
          } catch (err) {
            console.warn(`[Fathom] No se pudo obtener dueño de cita para contactId=${contact.id}:`, err instanceof Error ? err.message : err);
          }

          // Fallback al dueño del contacto si no se obtuvo el de la cita
          if (!closerEmailFromGhl && contact.assignedTo) {
            try {
              const ghlUser = await getGhlUser(contact.assignedTo, account.token_ghl);
              closerEmailFromGhl = ghlUser?.email ?? null;
              if (closerEmailFromGhl) {
                console.info(`[Fathom] Closer resuelto desde dueño de CONTACTO (fallback): ${closerEmailFromGhl}`);
              }
            } catch (err) {
              console.warn(`[Fathom] Could not fetch GHL user ${contact.assignedTo}:`, err);
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
        idCuenta,
        Array.isArray(account.canales_activos) ? account.canales_activos as string[] : null,
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

  // ── Fase 4b: Extracción cita/tarea desde videollamada ──────────────────────
  let citaTareaResult: CitaTareaExtraction | null = null;
  if (formattedTranscript && formattedTranscript.length >= 100) {
    try {
      citaTareaResult = await extractCitaTarea(
        formattedTranscript,
        meetingDate ?? new Date(),
        "America/Mexico_City",
        account.openai_api_key,
        idCuenta,
      );
      if (citaTareaResult) {
        console.info(
          `[Fathom] CitaTarea: cita=${citaTareaResult.cita.detectada} tarea=${citaTareaResult.tarea.detectada}`,
        );
      }
    } catch (err) {
      console.warn(`[Fathom] CitaTarea extraction error (fail-open):`, err instanceof Error ? err.message : err);
    }
  }

  // AUT-1301: Gemini enrichment + duración estimada desde transcript
  const geminiResult = formattedTranscript
    ? await enrichWithGemini(formattedTranscript, "videollamada", idCuenta).catch((err: unknown) => {
        console.error("[Fathom] Error enriquecimiento Gemini:", err);
        return null;
      })
    : null;
  const duracionSegundos = estimateDurationFromTranscript(payload.transcript ?? null);

  // Si alguna regla tiene funnelStage, la regla explícita del cliente sobreescribe la clasificación IA
  const funnelStageFromReglas = collectFunnelStages(reglasResult.matched_rules);

  // Aplicar acciones incrementar_metrica de reglas matcheadas
  if (reglasResult.matched_rules.length > 0 && idCuenta) {
    await applyReglasMetricActions(reglasResult.matched_rules, idCuenta, "[Fathom]", {
      eventTs: meetingDate ?? new Date(),
      eventKey: recordingId ? `fathom:${recordingId}` : null,
    });
  }

  // ── Fase 5: Sync final (GHL tag + DB update) ─────────────────────────────

  const locationId = account.locationid;

  // 5a. Aplicar tag de clasificación en GHL
  if (contactId && account.token_ghl && classifier) {
    try {
      const tag = categoriaToGhlTag(classifier.categoria);
      await safeAddContactTag(contactId, account.token_ghl, tag, locationId);
    } catch (err) {
      console.error(
        `[Fathom] GHL tag error for contact ${contactId}:`,
        err,
      );
    }
  }

  // 5a-bis. Tag de videollamada efectiva (hubo transcripción procesada)
  if (contactId && account.token_ghl && formattedTranscript) {
    try {
      await safeAddContactTag(contactId, account.token_ghl, GHL_TAGS.videollamada_efectiva, locationId);
    } catch (err) {
      console.error(
        `[Fathom] GHL videollamada_efectiva tag error for contact ${contactId}:`,
        err,
      );
    }
  }

  // 5a-ter. Aplicar tags de reglas_etiquetas en GHL
  if (contactId && account.token_ghl && tagsInternos.length > 0) {
    try {
      await safeAddContactTags(contactId, account.token_ghl, tagsInternos, locationId);
    } catch (err) {
      console.error(
        `[Fathom] GHL reglas tags error for contact ${contactId}:`,
        err,
      );
    }
  }

  // 5a-quater. Actualizar pipeline GHL si la regla tiene funnelStage configurado
  if (funnelStageFromReglas && contactId && account.token_ghl && account.locationid) {
    const stageMap = parseFunnelStageMap(account.embudo_personalizado);
    const stageId = stageMap[funnelStageFromReglas];
    if (stageId) {
      try {
        const oppId = await searchOpportunityByContact(contactId, account.locationid, account.token_ghl);
        if (oppId) {
          await updateOpportunityStage(oppId, stageId, account.token_ghl);
          console.info(
            `[Fathom] Opportunity ${oppId} movida a stage "${funnelStageFromReglas}" (stageId=${stageId}) para contact=${contactId}`,
          );
        } else {
          console.info(`[Fathom] Sin opportunity para contact=${contactId}, se omite stage update`);
        }
      } catch (err) {
        console.error(`[Fathom] Error actualizando pipeline GHL para contact=${contactId}:`, err);
      }
    }
  }

  // 5a-quinquies. Cita/tarea: custom fields + tarea GHL real + tag
  if (citaTareaResult && contactId && account.token_ghl) {
    const cfToWrite: Array<{ key: string; field_value: string }> = [];

    if (citaTareaResult.cita.detectada && citaTareaResult.cita.fecha_hora) {
      cfToWrite.push({ key: "fecha_y_hora_de_la_cita", field_value: citaTareaResult.cita.fecha_hora });
    }
    if (citaTareaResult.tarea.detectada) {
      if (citaTareaResult.tarea.titulo) {
        cfToWrite.push({ key: "titulo_de_la_tarea", field_value: citaTareaResult.tarea.titulo });
      }
      if (citaTareaResult.tarea.descripcion) {
        cfToWrite.push({ key: "descripcion_de_la_tarea", field_value: citaTareaResult.tarea.descripcion });
      }
      if (citaTareaResult.tarea.fecha_vencimiento) {
        cfToWrite.push({ key: "fecha_de_vencimiento_de_la_tarea", field_value: citaTareaResult.tarea.fecha_vencimiento });
      }
    }

    if (cfToWrite.length > 0) {
      try {
        await updateContactCustomFields(contactId, account.token_ghl, cfToWrite);
        console.info(`[Fathom] CitaTarea: wrote ${cfToWrite.length} custom fields to GHL`);
      } catch (err) {
        console.error(`[Fathom] CitaTarea: error writing custom fields (best-effort):`, err);
      }
    }

    if (citaTareaResult.tarea.detectada) {
      try {
        await safeAddContactTag(contactId, account.token_ghl, "tarea_registradaai", locationId);
        console.info(`[Fathom] CitaTarea: applied tag tarea_registradaai`);
      } catch (err) {
        console.error(`[Fathom] CitaTarea: error applying tarea_registradaai tag (best-effort):`, err);
      }

      if (account.ghl_native_task_workflow) {
        console.info(`[Fathom] [GHL native workflow] task creation skipped for cuenta ${idCuenta}`);
      } else {
        try {
          const tareaTitle = citaTareaResult.tarea.titulo ?? "Tarea de seguimiento (Auto KPI)";
          const tareaBody = citaTareaResult.tarea.descripcion ?? undefined;
          let dueDate = citaTareaResult.tarea.fecha_vencimiento;
          if (!dueDate) {
            const fallback = new Date((meetingDate ?? new Date()).getTime() + 7 * 24 * 60 * 60 * 1000);
            dueDate = fallback.toISOString();
          }

          let assignedTo: string | undefined;
          try {
            const apptInfo = await getContactAppointmentInfo(contactId, account.token_ghl, new Date());
            if (apptInfo?.assignedUserId) {
              assignedTo = apptInfo.assignedUserId;
            }
          } catch { /* best-effort */ }

          const taskResult = await createContactTask(contactId, account.token_ghl, {
            title: tareaTitle,
            body: tareaBody,
            dueDate,
            assignedTo,
          });
          if (taskResult) {
            console.info(`[Fathom] CitaTarea: created GHL task id=${taskResult.id}`);
          }
        } catch (err) {
          console.error(`[Fathom] CitaTarea: error creating GHL task (best-effort):`, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  // 5b. Upsert en resumenes_diarios_agendas:
  //   - Si ya existe registro (GHL agendó la cita): UPDATE con datos de IA.
  //   - Si NO existe (videollamada sin cita previa en GHL): INSERT completo.
  try {
    const [existing] = await withRetry(
      () =>
        drizzleDb
          .select({ id: agendas.id_registro_agenda, closer: agendas.closer, categoria: agendas.categoria })
          .from(agendas)
          .where(
            and(
              eq(agendas.id_cuenta, idCuenta),
              // Buscar por email_lead O por ghl_contact_id para evitar crear duplicados
              // cuando GHL crea el registro sin email (solo con contactId) y Fathom
              // llega después con el email → sin este OR se insertaba un segundo registro.
              or(
                eq(agendas.email_lead, emailLead),
                ...(contactId ? [eq(agendas.ghl_contact_id, contactId)] : []),
              ),
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
      const previousCategoria = existing.categoria;
      const nuevaCategoria = classifier ? (funnelStageFromReglas ?? classifier.categoria) : null;
      const categoriaChanged = nuevaCategoria !== null && nuevaCategoria !== existing.categoria;

      await withRetry(
        () =>
          drizzleDb
            .update(agendas)
            .set({
              link_llamada: shareUrl,
              ...(meetingDate ? { fechaReunion: meetingDate } : {}),
              fathom_recording_id: recordingId,
              fathom_share_url: shareUrl,
              fathom_processed_at: new Date(),
              fathom_ingestion_source: ingestionSource,
              // AUT-270: registrar re-ingesta solo cuando la categoría cambia en un UPDATE
              ...(categoriaChanged && {
                fathom_reingest_at: new Date(),
                categoria_previa: existing.categoria,
              }),
              ...(classifier && {
                categoria: nuevaCategoria,
                cash_collected: classifier.cash_collected,
                facturacion: classifier.facturacion,
              }),
              ...(analysisText && { resumen_ia: analysisText }),
              ...(objections && { objeciones_ia: objections }),
              ...(formattedTranscript && { transcripcion_fathom: formattedTranscript }),
              tags_internos: tagsInternos,
              ...(geminiResult && { gemini_enriquecimiento: geminiResult }),
              ...(duracionSegundos != null && { duracion_segundos: duracionSegundos }),
              ...(utmContent && { origen: utmContent }),
              ...(contactId && { ghl_contact_id: contactId }),
              ...(contactName && { nombre_de_lead: contactName }),
              // Solo actualizar closer si el registro no tiene uno asignado.
              // Si Sergio envía el closer correcto desde GHL en el PDTE, ese valor
              // ya quedó guardado y no hay que pisarlo con el recorded_by de Fathom
              // (Fathom puede ser un usuario compartido entre varios closers).
              ...(!existing.closer
                ? closerEmail ?? closerEmailFromGhl
                  ? { closer: closerEmail ?? closerEmailFromGhl }
                  : closerName
                    ? { closer: closerName }
                    : {}
                : {}),
            })
            .where(eq(agendas.id_registro_agenda, existing.id)),
        { label: "Fathom/updateAgenda" },
      );

      console.info(
        `[Fathom] Updated agenda record ${existing.id} for id_cuenta=${idCuenta}, email=${emailLead}, categoria=${classifier?.categoria ?? "N/A"}`,
      );

      // ── Limpiar tag noshowautoia de GHL si el registro cambió de no_show ──
      // Cuando el cron marca un lead como no_show y luego llega la grabación de
      // Fathom, el UPDATE arriba corrige la categoría en BD, pero el tag
      // 'noshowautoia' queda huérfano en GHL. Aquí lo removemos.
      if (
        previousCategoria === "no_show" &&
        nuevaCategoria !== null &&
        nuevaCategoria !== "no_show" &&
        contactId &&
        account.token_ghl
      ) {
        try {
          await removeContactTag(contactId, account.token_ghl, GHL_TAGS.noshow);
          console.info(
            `[Fathom] Removed GHL tag "${GHL_TAGS.noshow}" from contact ${contactId} — re-ingestion changed categoria from no_show → ${nuevaCategoria}`,
          );
        } catch (err) {
          console.error(
            `[Fathom] Failed to remove noshow GHL tag for contact ${contactId}:`,
            err,
          );
        }
      }
    } else {
      // ── INSERT: sin registro previo (videollamada sin cita en GHL) ───────
      const now = new Date();

      await withRetry(
        () =>
          drizzleDb.insert(agendas).values({
            id_cuenta: idCuenta,
            email_lead: emailLead,
            fecha: now,
            fechaReunion: meetingDate ?? now,
            nombre_de_lead: contactName,
            origen: utmContent,
            ghl_contact_id: contactId,
            // Para INSERT: priorizar recorded_by.email (quien realmente grabó en Fathom)
            // sobre contact.assignedTo en GHL (que puede ser el setter, no el closer)
            closer: closerEmail ?? closerEmailFromGhl ?? closerName ?? null,
            link_llamada: shareUrl,
            fathom_recording_id: recordingId,
            fathom_share_url: shareUrl,
            fathom_processed_at: now,
            fathom_ingestion_source: ingestionSource,
            ...(classifier && {
              categoria: funnelStageFromReglas ?? classifier.categoria,
              cash_collected: classifier.cash_collected,
              facturacion: classifier.facturacion,
            }),
            ...(analysisText && { resumen_ia: analysisText }),
            ...(objections && { objeciones_ia: objections }),
            ...(formattedTranscript && { transcripcion_fathom: formattedTranscript }),
            tags_internos: tagsInternos,
            ...(geminiResult && { gemini_enriquecimiento: geminiResult }),
            ...(duracionSegundos != null && { duracion_segundos: duracionSegundos }),
          }),
        { label: "Fathom/insertAgenda" },
      );

      console.info(
        `[Fathom] Inserted new agenda record for id_cuenta=${idCuenta}, email=${emailLead}, categoria=${classifier?.categoria ?? "N/A"}`,
      );

      // ── Registrar en log_llamadas como Lead Generado ─────────────────────────
      // Las videollamadas de Fathom sin cita previa en GHL crean un nuevo lead.
      // Sin este INSERT, el contador "Leads Generados" del dashboard no los incluye.
      try {
        await withRetry(
          () =>
            drizzleDb.insert(logLlamadas).values({
              id_registro: null,
              id_cuenta: idCuenta,
              mail_lead: emailLead,
              contact_id_ghl: contactId,
              nombre_lead: contactName,
              tipo_evento: "contacto_creado",
              closer_mail: closerEmail ?? closerEmailFromGhl ?? null,
              nombre_closer: closerName ?? null,
              creativo_origen: utmContent ?? null,
            }),
          { label: "Fathom/insertLogLlamada" },
        );
        console.info(
          `[Fathom] Inserted log_llamadas (contacto_creado) for id_cuenta=${idCuenta}, email=${emailLead}`,
        );
      } catch (logErr) {
        console.error(
          `[Fathom] Error insertando en log_llamadas para email=${emailLead}, id_cuenta=${idCuenta}:`,
          logErr,
        );
      }
    }
  } catch (err) {
    console.error(
      `[Fathom] DB upsert error for email=${emailLead}, id_cuenta=${idCuenta}:`,
      err,
    );
  }

  // ── Fase 6: Notas GHL (controladas por configuracion_ui.ghl_notas) ────────
  // Por defecto: nota IA = true, transcripción = false.
  // El cliente puede cambiarlos desde Sistema → Evaluación de videollamadas.
  if (contactId && account.token_ghl) {
    // Nota de análisis IA
    if (ghlNotasConfig.ia !== false) {
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
    }

    // Nota de transcripción completa (desactivada por defecto — puede superar 65k chars)
    if (ghlNotasConfig.transcripcion === true && formattedTranscript) {
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

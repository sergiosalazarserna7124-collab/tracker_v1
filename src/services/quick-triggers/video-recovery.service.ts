import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import {
  agendas,
  cuentas,
  eventosHuerfanos,
  usuariosDashboard,
} from "../../db/schema.js";
import type {
  MeetingSnapshotType,
  VideoRecoveryExecuteBodyType,
  VideoRecoveryPreviewBodyType,
  VideoRecoveryRelinkBodyType,
  VideoRecoveryAgendaSearchBodyType,
} from "../../schemas/quick-triggers/video-recovery.schema.js";
import { fetchWithTimeout } from "../../utils/fetch.utils.js";
import { processFathomCall } from "../webhooks/fathom.service.js";
import { analyzeCall } from "../ai/call-analysis.service.js";
import { extractCitaTarea } from "../ai/cita-tarea-extraction.service.js";
import { enrichWithGemini, resolveGeminiKey, estimateDurationFromTranscript } from "../ai/gemini-enrichment.service.js";
import { collectFunnelStages, applyReglasMetricActions } from "../ai/reglas-actions.service.js";

const FATHOM_BASE_URL = "https://api.fathom.ai/external/v1";
const PREVIEW_MAX_LIMIT = 200;
const DEFAULT_PREVIEW_LIMIT = 50;

type FathomTranscriptItem = {
  speaker?: {
    display_name?: string;
    matched_calendar_invitee_email?: string | null;
  };
  text: string;
  timestamp?: string;
};

type FathomMeetingItem = MeetingSnapshotType;

interface FathomMeetingsResponse {
  limit: number | null;
  next_cursor: string | null;
  items: FathomMeetingItem[];
}

interface FathomTranscriptResponse {
  transcript: FathomTranscriptItem[];
}

interface PreviewItemResult {
  recording_id: number;
  meeting_title: string | null;
  share_url: string | null;
  scheduled_start_time: string | null;
  lead_email_detected: string | null;
  estado_bd_actual: string;
  accion_sugerida: "recover_existing" | "create_if_missing" | "skip";
  motivo: string;
  id_registro_agenda: number | null;
  meeting_snapshot: MeetingSnapshotType;
}

interface ExecuteItemResult {
  recording_id: number;
  action: "recover_existing" | "create_if_missing" | "skip";
  status: "processed" | "skipped" | "error";
  estado_anterior: string | null;
  estado_final: string | null;
  motivo: string;
}

function normalizeIso(value: string): string | null {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function pickLeadEmail(meeting: FathomMeetingItem): string | null {
  const closerEmail = meeting.recorded_by?.email ?? null;
  const invitees = Array.isArray(meeting.calendar_invitees)
    ? meeting.calendar_invitees
    : [];
  const external = invitees.find((inv) => inv.is_external && inv.email !== closerEmail);
  return external?.email ?? null;
}

function isRecoverableCategoria(categoria: string | null): boolean {
  const value = (categoria ?? "").trim().toLowerCase();
  return value === "pdte" || value === "pendiente" || value === "no_show";
}

async function resolveFathomKey(
  idCuenta: number,
  idEvento: string,
): Promise<{ fathomKey: string | null }> {
  const [row] = await drizzleDb
    .select({
      fathom: usuariosDashboard.fathom,
    })
    .from(usuariosDashboard)
    .where(
      and(
        eq(usuariosDashboard.id_cuenta, idCuenta),
        eq(usuariosDashboard.id_evento, idEvento),
      ),
    )
    .limit(1);

  if (!row) return { fathomKey: null };
  const key = row.fathom?.trim() ?? null;
  return { fathomKey: key && key.length > 0 ? key : null };
}

async function callFathomMeetings(
  fathomApiKey: string,
  body: VideoRecoveryPreviewBodyType,
  cursor?: string,
): Promise<FathomMeetingsResponse> {
  const params = new URLSearchParams();

  params.append("created_after", body.from);
  params.append("created_before", body.to);
  params.append("calendar_invitees_domains_type", body.calendar_invitees_domains_type ?? "all");
  params.append("limit", String(Math.min(body.limit ?? DEFAULT_PREVIEW_LIMIT, PREVIEW_MAX_LIMIT)));
  if (cursor) params.append("cursor", cursor);

  for (const item of body.teams ?? []) params.append("teams[]", item);
  for (const item of body.recorded_by ?? []) params.append("recorded_by[]", item);
  for (const item of body.calendar_invitees_domains ?? []) {
    params.append("calendar_invitees_domains[]", item);
  }

  const response = await fetchWithTimeout(
    `${FATHOM_BASE_URL}/meetings?${params.toString()}`,
    {
      method: "GET",
      headers: {
        "X-Api-Key": fathomApiKey,
      },
    },
    30_000,
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Fathom meetings ${response.status}: ${detail}`);
  }

  const json = (await response.json()) as Partial<FathomMeetingsResponse>;
  return {
    limit: json.limit ?? null,
    next_cursor: json.next_cursor ?? null,
    items: Array.isArray(json.items) ? json.items : [],
  };
}

async function callFathomTranscript(
  fathomApiKey: string,
  recordingId: number,
): Promise<FathomTranscriptItem[]> {
  const response = await fetchWithTimeout(
    `${FATHOM_BASE_URL}/recordings/${recordingId}/transcript`,
    {
      method: "GET",
      headers: {
        "X-Api-Key": fathomApiKey,
      },
    },
    30_000,
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Fathom transcript ${response.status}: ${detail}`);
  }

  const json = (await response.json()) as Partial<FathomTranscriptResponse>;
  return Array.isArray(json.transcript) ? json.transcript : [];
}

export async function previewVideoRecovery(
  idCuenta: number,
  body: VideoRecoveryPreviewBodyType,
): Promise<{ items: PreviewItemResult[] }> {
  const from = normalizeIso(body.from);
  const to = normalizeIso(body.to);

  if (!from || !to) {
    throw new Error("Invalid date range. Use ISO timestamps in from/to.");
  }
  if (new Date(from).getTime() > new Date(to).getTime()) {
    throw new Error("Invalid date range. 'from' must be <= 'to'.");
  }

  const { fathomKey } = await resolveFathomKey(idCuenta, body.id_evento);
  if (!fathomKey) {
    throw new Error("Selected user has no active Fathom API key or does not belong to this tenant.");
  }

  const maxItems = Math.min(body.limit ?? DEFAULT_PREVIEW_LIMIT, PREVIEW_MAX_LIMIT);
  const meetings: FathomMeetingItem[] = [];
  let cursor: string | undefined;

  while (meetings.length < maxItems) {
    const page = await callFathomMeetings(fathomKey, { ...body, from, to, limit: maxItems }, cursor);
    if (page.items.length === 0) break;
    meetings.push(...page.items.slice(0, maxItems - meetings.length));
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }

  const recordingIds = meetings.map((m) => String(m.recording_id));
  const existingByRecording = recordingIds.length > 0
    ? await drizzleDb
      .select({
        id_registro_agenda: agendas.id_registro_agenda,
        recording_id: agendas.fathom_recording_id,
        categoria: agendas.categoria,
      })
      .from(agendas)
      .where(
        and(
          eq(agendas.id_cuenta, idCuenta),
          inArray(agendas.fathom_recording_id, recordingIds),
        ),
      )
    : [];

  const byRecordingId = new Map<string, { id_registro_agenda: number; categoria: string | null }>();
  for (const row of existingByRecording) {
    if (row.recording_id) {
      byRecordingId.set(row.recording_id, {
        id_registro_agenda: row.id_registro_agenda,
        categoria: row.categoria,
      });
    }
  }

  const results: PreviewItemResult[] = [];
  for (const meeting of meetings) {
    const recordingId = String(meeting.recording_id);
    const alreadyProcessed = byRecordingId.get(recordingId);
    const leadEmail = pickLeadEmail(meeting);

    if (alreadyProcessed) {
      // Si el registro tiene recording_id pero sigue en no_show/PDTE, el cron lo marcó
      // antes de que Fathom enviara el webhook. Hay que recuperarlo, no ignorarlo.
      const categoriaActual = (alreadyProcessed.categoria ?? "").toLowerCase().trim();
      const esRecuperableConRecording = categoriaActual === "no_show" || categoriaActual === "pdte" || categoriaActual === "pendiente";

      if (esRecuperableConRecording) {
        results.push({
          recording_id: meeting.recording_id,
          meeting_title: meeting.meeting_title ?? meeting.title ?? null,
          share_url: meeting.share_url ?? meeting.url ?? null,
          scheduled_start_time: meeting.scheduled_start_time ?? null,
          lead_email_detected: leadEmail,
          estado_bd_actual: alreadyProcessed.categoria ?? "no_show",
          accion_sugerida: "recover_existing",
          motivo: "El cron marcó esta cita como no-show antes de que Fathom procesara la grabación. La reunión SÍ ocurrió — se puede recuperar.",
          id_registro_agenda: alreadyProcessed.id_registro_agenda,
          meeting_snapshot: meeting,
        });
      } else {
        results.push({
          recording_id: meeting.recording_id,
          meeting_title: meeting.meeting_title ?? meeting.title ?? null,
          share_url: meeting.share_url ?? meeting.url ?? null,
          scheduled_start_time: meeting.scheduled_start_time ?? null,
          lead_email_detected: leadEmail,
          estado_bd_actual: alreadyProcessed.categoria ?? "ya_procesada",
          accion_sugerida: "skip",
          motivo: "Esta videollamada ya fue procesada (recording_id existente).",
          id_registro_agenda: alreadyProcessed.id_registro_agenda,
          meeting_snapshot: meeting,
        });
      }
      continue;
    }

    if (!leadEmail) {
      const titleLower = (meeting.meeting_title ?? meeting.title ?? "").toLowerCase();
      const isImpromptu = titleLower.includes("impromptu");
      results.push({
        recording_id: meeting.recording_id,
        meeting_title: meeting.meeting_title ?? meeting.title ?? null,
        share_url: meeting.share_url ?? meeting.url ?? null,
        scheduled_start_time: meeting.scheduled_start_time ?? null,
        lead_email_detected: null,
        estado_bd_actual: isImpromptu ? "impromptu_interno" : "sin_email_externo",
        accion_sugerida: "skip",
        motivo: isImpromptu
          ? "Reunión impromptu sin lead externo — se descartará automáticamente (no es llamada de ventas)."
          : "Sin invitado externo identificable. Se recomienda ignorar o enviar a huérfanos.",
        id_registro_agenda: null,
        meeting_snapshot: meeting,
      });
      continue;
    }

    const [agendaCandidate] = await drizzleDb
      .select({
        id_registro_agenda: agendas.id_registro_agenda,
        categoria: agendas.categoria,
      })
      .from(agendas)
      .where(
        and(
          eq(agendas.id_cuenta, idCuenta),
          sql`LOWER(${agendas.email_lead}) = LOWER(${leadEmail})`,
          or(
            eq(agendas.categoria, "PDTE"),
            eq(agendas.categoria, "pdte"),
            eq(agendas.categoria, "no_show"),
            eq(agendas.categoria, "pendiente"),
          ),
        ),
      )
      .orderBy(desc(agendas.fechaReunion))
      .limit(1);

    if (agendaCandidate) {
      results.push({
        recording_id: meeting.recording_id,
        meeting_title: meeting.meeting_title ?? meeting.title ?? null,
        share_url: meeting.share_url ?? meeting.url ?? null,
        scheduled_start_time: meeting.scheduled_start_time ?? null,
        lead_email_detected: leadEmail,
        estado_bd_actual: agendaCandidate.categoria ?? "PDTE",
        accion_sugerida: "recover_existing",
        motivo: "Coincide con un registro pendiente/no_show en BD.",
        id_registro_agenda: agendaCandidate.id_registro_agenda,
        meeting_snapshot: meeting,
      });
      continue;
    }

    // Antes de marcar como sin_match, verificar si este email ya tiene
    // cualquier registro en BD con la grabación de Fathom ya procesada
    // (calificada, cerrada, no_calificada, cancelada, etc.)
    // Si existe → la reunión YA fue procesada correctamente → skip silencioso
    const [yaExiste] = await drizzleDb
      .select({ id_registro_agenda: agendas.id_registro_agenda, categoria: agendas.categoria })
      .from(agendas)
      .where(
        and(
          eq(agendas.id_cuenta, idCuenta),
          sql`LOWER(${agendas.email_lead}) = LOWER(${leadEmail})`,
        ),
      )
      .orderBy(desc(agendas.fechaReunion))
      .limit(1);

    if (yaExiste) {
      // El lead tiene registros en BD (procesados) → no mostrar en el panel
      results.push({
        recording_id: meeting.recording_id,
        meeting_title: meeting.meeting_title ?? meeting.title ?? null,
        share_url: meeting.share_url ?? meeting.url ?? null,
        scheduled_start_time: meeting.scheduled_start_time ?? null,
        lead_email_detected: leadEmail,
        estado_bd_actual: yaExiste.categoria ?? "ya_procesada",
        accion_sugerida: "skip",
        motivo: `Lead ya tiene registros en BD (estado: ${yaExiste.categoria ?? "desconocido"}). No requiere acción.`,
        id_registro_agenda: yaExiste.id_registro_agenda,
        meeting_snapshot: meeting,
      });
      continue;
    }

    results.push({
      recording_id: meeting.recording_id,
      meeting_title: meeting.meeting_title ?? meeting.title ?? null,
      share_url: meeting.share_url ?? meeting.url ?? null,
      scheduled_start_time: meeting.scheduled_start_time ?? null,
      lead_email_detected: leadEmail,
      estado_bd_actual: "sin_match_bd",
      accion_sugerida: "create_if_missing",
      motivo: "No existe ningún registro para ese lead. Se puede crear uno nuevo.",
      id_registro_agenda: null,
      meeting_snapshot: meeting,
    });
  }

  return { items: results };
}

async function saveFathomOrphan(
  idCuenta: number,
  payload: MeetingSnapshotType,
  motivo: string,
): Promise<void> {
  await drizzleDb.insert(eventosHuerfanos).values({
    id_cuenta: idCuenta,
    origen: "fathom",
    motivo,
    payload_original: payload,
    estado: "pendiente",
  });
}

export async function executeVideoRecovery(
  idCuenta: number,
  body: VideoRecoveryExecuteBodyType,
): Promise<{
  processed: number;
  skipped: number;
  errors: number;
  items: ExecuteItemResult[];
}> {
  const { fathomKey } = await resolveFathomKey(idCuenta, body.id_evento);
  if (!fathomKey) {
    throw new Error("Selected user has no active Fathom API key or does not belong to this tenant.");
  }

  const seenRecordingIds = new Set<number>();
  const results: ExecuteItemResult[] = [];

  for (const item of body.selected_recordings) {
    if (seenRecordingIds.has(item.recording_id)) {
      results.push({
        recording_id: item.recording_id,
        action: item.action,
        status: "skipped",
        estado_anterior: null,
        estado_final: null,
        motivo: "recording_id duplicado dentro del mismo request.",
      });
      continue;
    }
    seenRecordingIds.add(item.recording_id);

    if (item.action === "skip") {
      results.push({
        recording_id: item.recording_id,
        action: item.action,
        status: "skipped",
        estado_anterior: null,
        estado_final: null,
        motivo: "Ignorado por selección del usuario.",
      });
      continue;
    }

    const [alreadyProcessed] = await drizzleDb
      .select({
        id_registro_agenda: agendas.id_registro_agenda,
        categoria: agendas.categoria,
      })
      .from(agendas)
      .where(
        and(
          eq(agendas.id_cuenta, idCuenta),
          eq(agendas.fathom_recording_id, String(item.recording_id)),
        ),
      )
      .limit(1);

    if (alreadyProcessed) {
      // Si el registro tiene recording_id pero sigue en no_show/PDTE,
      // el cron lo marcó antes de que llegara Fathom → permitir recuperar
      const categoriaAlreadyProcessed = (alreadyProcessed.categoria ?? "").toLowerCase().trim();
      const debeRecuperar = categoriaAlreadyProcessed === "no_show" || categoriaAlreadyProcessed === "pdte" || categoriaAlreadyProcessed === "pendiente";

      if (!debeRecuperar) {
        results.push({
          recording_id: item.recording_id,
          action: item.action,
          status: "skipped",
          estado_anterior: alreadyProcessed.categoria,
          estado_final: alreadyProcessed.categoria,
          motivo: "Ya procesada anteriormente para esta cuenta.",
        });
        continue;
      }
      // Si debe recuperar: el cron la marcó no_show antes de que llegara Fathom
      // Forzar recover_existing con el id_registro_agenda encontrado por recording_id
      // (continúa el flujo normal más abajo usando effectiveItem)
    }

    // effectiveItem: puede ser el item original o el ajustado si alreadyProcessed debía recuperarse
    const effectiveIdRegistro = alreadyProcessed?.id_registro_agenda ?? item.id_registro_agenda;
    const effectiveAction: typeof item.action = alreadyProcessed && (
      (alreadyProcessed.categoria ?? "").toLowerCase().trim() === "no_show" ||
      (alreadyProcessed.categoria ?? "").toLowerCase().trim() === "pdte" ||
      (alreadyProcessed.categoria ?? "").toLowerCase().trim() === "pendiente"
    ) ? "recover_existing" : item.action;

    let estadoAnterior: string | null = null;
    if (effectiveIdRegistro) {
      const [agendaById] = await drizzleDb
        .select({ categoria: agendas.categoria })
        .from(agendas)
        .where(
          and(
            eq(agendas.id_cuenta, idCuenta),
            eq(agendas.id_registro_agenda, effectiveIdRegistro),
          ),
        )
        .limit(1);
      estadoAnterior = agendaById?.categoria ?? null;
    }

    if (effectiveAction === "recover_existing" && !isRecoverableCategoria(estadoAnterior)) {
      results.push({
        recording_id: item.recording_id,
        action: effectiveAction,
        status: "skipped",
        estado_anterior: estadoAnterior,
        estado_final: estadoAnterior,
        motivo: "El registro objetivo no está en estado pendiente/no_show.",
      });
      continue;
    }

    try {
      const transcript = await callFathomTranscript(fathomKey, item.recording_id);
      const leadEmail = pickLeadEmail(item.meeting_snapshot);
      if (!leadEmail) {
        // Reuniones Impromptu sin invitados externos son llamadas internas del equipo — no son leads de ventas
        const meetingTitle = (item.meeting_snapshot.meeting_title ?? item.meeting_snapshot.title ?? "").toLowerCase();
        if (meetingTitle.includes("impromptu")) {
          console.info(
            `[VideoRecovery] Skipping Impromptu internal meeting recording_id=${item.recording_id} for id_cuenta=${idCuenta}`,
          );
          results.push({
            recording_id: item.recording_id,
            action: item.action,
            status: "skipped",
            estado_anterior: estadoAnterior,
            estado_final: estadoAnterior,
            motivo: "Reunión impromptu sin lead externo — descartada automáticamente (no es llamada de ventas).",
          });
          continue;
        }

        await saveFathomOrphan(
          idCuenta,
          item.meeting_snapshot,
          "Recuperación rápida sin invitado externo/email identificable",
        );
        results.push({
          recording_id: item.recording_id,
          action: item.action,
          status: "skipped",
          estado_anterior: estadoAnterior,
          estado_final: estadoAnterior,
          motivo: "Enviado a eventos_huerfanos por falta de email externo.",
        });
        continue;
      }

      const normalizedTranscript = transcript.map((row) => ({
        speaker: row.speaker ?? {},
        text: row.text,
        timestamp: row.timestamp,
      }));

      const snapshot = item.meeting_snapshot;
      const normalizedRecordedBy = snapshot.recorded_by
        ? {
          name: snapshot.recorded_by.name,
          email: snapshot.recorded_by.email,
          ...(snapshot.recorded_by.email_domain ? { email_domain: snapshot.recorded_by.email_domain } : {}),
          ...(snapshot.recorded_by.team != null ? { team: snapshot.recorded_by.team } : {}),
        }
        : undefined;
      const normalizedInvitees = snapshot.calendar_invitees?.map((inv) => ({
        email: inv.email,
        is_external: inv.is_external,
        ...(inv.name ? { name: inv.name } : {}),
        ...(inv.matched_speaker_display_name ? { matched_speaker_display_name: inv.matched_speaker_display_name } : {}),
        ...(inv.email_domain ? { email_domain: inv.email_domain } : {}),
      }));
      const fathomPayload = {
        recording_id: snapshot.recording_id,
        ...(snapshot.url ? { url: snapshot.url } : {}),
        ...(snapshot.share_url ? { share_url: snapshot.share_url } : {}),
        ...(snapshot.title ? { title: snapshot.title } : {}),
        ...(snapshot.meeting_title ? { meeting_title: snapshot.meeting_title } : {}),
        ...(snapshot.created_at ? { created_at: snapshot.created_at } : {}),
        ...(snapshot.scheduled_start_time ? { scheduled_start_time: snapshot.scheduled_start_time } : {}),
        ...(snapshot.scheduled_end_time ? { scheduled_end_time: snapshot.scheduled_end_time } : {}),
        ...(snapshot.recording_start_time ? { recording_start_time: snapshot.recording_start_time } : {}),
        ...(snapshot.recording_end_time ? { recording_end_time: snapshot.recording_end_time } : {}),
        ...(normalizedRecordedBy ? { recorded_by: normalizedRecordedBy } : {}),
        ...(normalizedInvitees ? { calendar_invitees: normalizedInvitees } : {}),
        transcript: normalizedTranscript,
      };

      await processFathomCall(idCuenta, fathomPayload, {
        ingestionSource: "quick_recovery",
      });

      const [finalRow] = await drizzleDb
        .select({
          categoria: agendas.categoria,
        })
        .from(agendas)
        .where(
          and(
            eq(agendas.id_cuenta, idCuenta),
            eq(agendas.fathom_recording_id, String(item.recording_id)),
          ),
        )
        .orderBy(desc(agendas.id_registro_agenda))
        .limit(1);

      results.push({
        recording_id: item.recording_id,
        action: effectiveAction,
        status: "processed",
        estado_anterior: estadoAnterior,
        estado_final: finalRow?.categoria ?? null,
        motivo: estadoAnterior === "no_show"
          ? "Registro recuperado — el cron lo había marcado no_show antes de que Fathom procesara la grabación."
          : "Videollamada recuperada y procesada.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown execute error";
      results.push({
        recording_id: item.recording_id,
        action: effectiveAction,
        status: "error",
        estado_anterior: estadoAnterior,
        estado_final: estadoAnterior,
        motivo: message,
      });
    }
  }

  return {
    processed: results.filter((r) => r.status === "processed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errors: results.filter((r) => r.status === "error").length,
    items: results,
  };
}

// ─── Relink: vincular manualmente una grabación Fathom a un registro de agenda ─

interface RelinkResult {
  id_registro_agenda: number;
  recording_id: number;
  status: "processed" | "error";
  estado_anterior: string | null;
  estado_final: string | null;
  motivo: string;
}

function formatTranscriptItems(
  items: Array<{ speaker?: Record<string, unknown>; text: string }>,
): string {
  return items
    .map((t) => {
      const name =
        (t.speaker as { display_name?: string } | undefined)?.display_name ?? "Unknown";
      return `${name}: ${t.text}`;
    })
    .join("\n");
}

export async function relinkRecordingToAgenda(
  idCuenta: number,
  body: VideoRecoveryRelinkBodyType,
): Promise<RelinkResult> {
  const { fathomKey } = await resolveFathomKey(idCuenta, body.id_evento);
  if (!fathomKey) {
    throw new Error("Selected user has no active Fathom API key or does not belong to this tenant.");
  }

  const [targetAgenda] = await drizzleDb
    .select({
      id_registro_agenda: agendas.id_registro_agenda,
      categoria: agendas.categoria,
      email_lead: agendas.email_lead,
      ghl_contact_id: agendas.ghl_contact_id,
    })
    .from(agendas)
    .where(
      and(
        eq(agendas.id_cuenta, idCuenta),
        eq(agendas.id_registro_agenda, body.id_registro_agenda),
      ),
    )
    .limit(1);

  if (!targetAgenda) {
    throw new Error(`Agenda record ${body.id_registro_agenda} not found for account ${idCuenta}.`);
  }

  const estadoAnterior = targetAgenda.categoria;

  try {
    const transcript = await callFathomTranscript(fathomKey, body.recording_id);
    const formattedTranscript = formatTranscriptItems(
      transcript.map((t) => ({ speaker: t.speaker as Record<string, unknown>, text: t.text })),
    );

    if (!formattedTranscript) {
      return {
        id_registro_agenda: body.id_registro_agenda,
        recording_id: body.recording_id,
        status: "error",
        estado_anterior: estadoAnterior,
        estado_final: estadoAnterior,
        motivo: "La grabación no tiene transcripción disponible en Fathom.",
      };
    }

    const [account] = await drizzleDb
      .select({
        prompt_ventas: cuentas.prompt_ventas,
        prompt_videollamadas: cuentas.prompt_videollamadas,
        openai_api_key: cuentas.openai_api_key,
        embudo_personalizado: cuentas.embudo_personalizado,
        reglas_etiquetas: cuentas.reglas_etiquetas,
        canales_activos: cuentas.canales_activos,
        gemini_api_key: cuentas.gemini_api_key,
        gemini_premium_status: cuentas.gemini_premium_status,
      })
      .from(cuentas)
      .where(eq(cuentas.id_cuenta, idCuenta))
      .limit(1);

    if (!account) {
      throw new Error(`Account ${idCuenta} not found.`);
    }

    const canalesActivos = Array.isArray(account.canales_activos)
      ? (account.canales_activos as string[])
      : null;

    const [aiResult, citaTareaResult, geminiResult, duracionSegundos] = await Promise.all([
      analyzeCall(
        formattedTranscript,
        account.prompt_ventas,
        account.prompt_videollamadas,
        account.openai_api_key,
        account.embudo_personalizado,
        account.reglas_etiquetas,
        idCuenta,
        canalesActivos,
      ),
      formattedTranscript.length >= 100
        ? extractCitaTarea(
            formattedTranscript,
            new Date(),
            "America/Mexico_City",
            account.openai_api_key,
            idCuenta,
          ).catch(() => null)
        : Promise.resolve(null),
      enrichWithGemini(
        formattedTranscript,
        "videollamada",
        idCuenta,
        resolveGeminiKey(account),
      ).catch(() => null),
      Promise.resolve(estimateDurationFromTranscript(transcript)),
    ]);

    const classifier = aiResult.classifier;
    const analysisText = aiResult.analysisText;
    const objections = aiResult.objections;
    const reglasResult = aiResult.reglasResult;
    const tagsInternos = reglasResult.matched_tags;
    const funnelStageFromReglas = collectFunnelStages(reglasResult.matched_rules);

    if (reglasResult.matched_rules.length > 0) {
      await applyReglasMetricActions(reglasResult.matched_rules, idCuenta, "[Relink]", {
        eventTs: new Date(),
        eventKey: `fathom:${body.recording_id}`,
      });
    }

    const snapshot = body.meeting_snapshot;
    const shareUrl = snapshot.share_url ?? snapshot.url ?? null;
    const meetingDate = snapshot.scheduled_start_time
      ? new Date(snapshot.scheduled_start_time)
      : snapshot.recording_start_time
        ? new Date(snapshot.recording_start_time)
        : null;

    const nuevaCategoria = classifier
      ? (funnelStageFromReglas ?? classifier.categoria)
      : null;
    const categoriaChanged = nuevaCategoria !== null && nuevaCategoria !== estadoAnterior;

    await drizzleDb
      .update(agendas)
      .set({
        link_llamada: shareUrl,
        ...(meetingDate && !Number.isNaN(meetingDate.getTime()) ? { fechaReunion: meetingDate } : {}),
        fathom_recording_id: String(body.recording_id),
        fathom_share_url: shareUrl,
        fathom_processed_at: new Date(),
        fathom_ingestion_source: "manual_relink",
        ...(categoriaChanged && {
          fathom_reingest_at: new Date(),
          categoria_previa: estadoAnterior,
        }),
        ...(classifier && {
          categoria: nuevaCategoria,
          cash_collected: classifier.cash_collected,
          facturacion: classifier.facturacion,
        }),
        ...(analysisText && { resumen_ia: analysisText }),
        ...(objections && { objeciones_ia: objections }),
        transcripcion_fathom: formattedTranscript,
        tags_internos: tagsInternos,
        ...(geminiResult && { gemini_enriquecimiento: geminiResult }),
        ...(duracionSegundos != null && { duracion_segundos: duracionSegundos }),
      })
      .where(eq(agendas.id_registro_agenda, body.id_registro_agenda));

    console.info(
      `[Relink] Updated agenda ${body.id_registro_agenda} with Fathom recording ${body.recording_id} for id_cuenta=${idCuenta}, categoria=${nuevaCategoria ?? "N/A"}`,
    );

    const [finalRow] = await drizzleDb
      .select({ categoria: agendas.categoria })
      .from(agendas)
      .where(eq(agendas.id_registro_agenda, body.id_registro_agenda))
      .limit(1);

    return {
      id_registro_agenda: body.id_registro_agenda,
      recording_id: body.recording_id,
      status: "processed",
      estado_anterior: estadoAnterior,
      estado_final: finalRow?.categoria ?? null,
      motivo: "Grabación vinculada y re-procesada exitosamente.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown relink error";
    console.error(`[Relink] Error for agenda=${body.id_registro_agenda}, recording=${body.recording_id}:`, err);
    return {
      id_registro_agenda: body.id_registro_agenda,
      recording_id: body.recording_id,
      status: "error",
      estado_anterior: estadoAnterior,
      estado_final: estadoAnterior,
      motivo: message,
    };
  }
}

// ─── Agenda Search: buscar registros de agenda candidatos para relink ──────────

interface AgendaSearchResult {
  id_registro_agenda: number;
  nombre_de_lead: string | null;
  email_lead: string | null;
  fecha: string | null;
  fecha_reunion: string | null;
  categoria: string | null;
  closer: string | null;
  fathom_recording_id: string | null;
}

export async function searchAgendasForRelink(
  idCuenta: number,
  body: VideoRecoveryAgendaSearchBodyType,
): Promise<{ items: AgendaSearchResult[] }> {
  const limit = Math.min(body.limit ?? 30, 100);

  const conditions = [eq(agendas.id_cuenta, idCuenta)];

  if (body.q) {
    const searchTerm = `%${body.q}%`;
    conditions.push(
      or(
        sql`${agendas.nombre_de_lead} ILIKE ${searchTerm}`,
        sql`${agendas.email_lead} ILIKE ${searchTerm}`,
      )!,
    );
  }

  if (body.fecha_from) {
    const from = new Date(body.fecha_from);
    if (!Number.isNaN(from.getTime())) {
      conditions.push(sql`${agendas.fecha} >= ${from.toISOString()}`);
    }
  }

  if (body.fecha_to) {
    const to = new Date(body.fecha_to);
    if (!Number.isNaN(to.getTime())) {
      conditions.push(sql`${agendas.fecha} <= ${to.toISOString()}`);
    }
  }

  if (body.categoria) {
    conditions.push(eq(agendas.categoria, body.categoria));
  }

  const rows = await drizzleDb
    .select({
      id_registro_agenda: agendas.id_registro_agenda,
      nombre_de_lead: agendas.nombre_de_lead,
      email_lead: agendas.email_lead,
      fecha: agendas.fecha,
      fecha_reunion: agendas.fechaReunion,
      categoria: agendas.categoria,
      closer: agendas.closer,
      fathom_recording_id: agendas.fathom_recording_id,
    })
    .from(agendas)
    .where(and(...conditions))
    .orderBy(desc(agendas.fecha))
    .limit(limit);

  return {
    items: rows.map((r) => ({
      ...r,
      fecha: r.fecha?.toISOString() ?? null,
      fecha_reunion: r.fecha_reunion?.toISOString() ?? null,
    })),
  };
}

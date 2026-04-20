import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import {
  agendas,
  eventosHuerfanos,
  usuariosDashboard,
} from "../../db/schema.js";
import type {
  MeetingSnapshotType,
  VideoRecoveryExecuteBodyType,
  VideoRecoveryPreviewBodyType,
} from "../../schemas/quick-triggers/video-recovery.schema.js";
import { fetchWithTimeout } from "../../utils/fetch.utils.js";
import { processFathomCall } from "../webhooks/fathom.service.js";

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

    results.push({
      recording_id: meeting.recording_id,
      meeting_title: meeting.meeting_title ?? meeting.title ?? null,
      share_url: meeting.share_url ?? meeting.url ?? null,
      scheduled_start_time: meeting.scheduled_start_time ?? null,
      lead_email_detected: leadEmail,
      estado_bd_actual: "sin_match_bd",
      accion_sugerida: "create_if_missing",
      motivo: "No existe un registro pendiente/no_show para ese lead. Se puede crear uno nuevo.",
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

    let estadoAnterior: string | null = null;
    if (item.id_registro_agenda) {
      const [agendaById] = await drizzleDb
        .select({ categoria: agendas.categoria })
        .from(agendas)
        .where(
          and(
            eq(agendas.id_cuenta, idCuenta),
            eq(agendas.id_registro_agenda, item.id_registro_agenda),
          ),
        )
        .limit(1);
      estadoAnterior = agendaById?.categoria ?? null;
    }

    if (item.action === "recover_existing" && !isRecoverableCategoria(estadoAnterior)) {
      results.push({
        recording_id: item.recording_id,
        action: item.action,
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
        action: item.action,
        status: "processed",
        estado_anterior: estadoAnterior,
        estado_final: finalRow?.categoria ?? null,
        motivo: "Videollamada recuperada y procesada.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown execute error";
      results.push({
        recording_id: item.recording_id,
        action: item.action,
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

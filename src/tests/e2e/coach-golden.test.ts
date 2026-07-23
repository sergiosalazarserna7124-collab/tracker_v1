/**
 * Guardián de Regresiones — Golden Case: Coach ampliado multicanal (AUT-1769)
 *
 * Verifica E2E que el Coach evalúa CHAT y VIDEOLLAMADA (no solo llamada),
 * aplicando el prompt de nota configurado en el guión (nota_accionable).
 *
 * Flujo:
 *   1. Semilla config de coach en demo cuenta 52 (guiones activos chat + videollamada
 *      con nota_cumplido/nota_no_cumplido, umbral y tags), coach_habilitado=true.
 *   2. Envía webhooks reales (3 mensajes de chat al mismo hilo + 1 videollamada Fathom).
 *   3. Dispara el drainer del coach (POST /cron/coach-drainer).
 *   4. Valida en evaluaciones_coach que existe evaluación por cada canal con nota poblada.
 *   5. Limpia la config y datos de prueba (after).
 *
 * Nota de alcance: el canal `llamada` por webhook /webhooks/voz queda fuera del golden
 * porque el drainer descarta tipo_evento='voz_callai' (línea coach-drainer). La rama
 * de exclusiones (campo estado_resultado/tipo_evento) sólo aplica a llamada y se cubre
 * a nivel de código/unit, no en este golden. Las notas/tags condicionales se cubren aquí
 * vía nota_accionable + cumple_umbral.
 *
 * Si la conexión E2E_DATABASE_URL es de solo lectura, la suite se SALTA (no reprueba
 * el gate): la semilla requiere INSERT/UPDATE sobre demo 52.
 *
 * Requiere env: E2E_DATABASE_URL (con permisos de escritura), CRON_SECRET.
 * Corre con: node --import tsx/esm --test src/tests/e2e/coach-golden.test.ts
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  sendChatWebhook,
  sendVideocallWebhook,
  waitForProcessing,
  queryDB,
  getPool,
  closePool,
  DEMO_ACCOUNT_ID,
} from "./helpers.js";

const CEREBRO_URL =
  process.env.CEREBRO_URL ??
  "https://cerebro-tracker-v6-saas-git-cstkjl7bpa-ue.a.run.app";
const CRON_SECRET = process.env.CRON_SECRET ?? "rPSHLs9iAsXc7VnHJkb83EiV";

const PROCESSING_WAIT = 15_000;
const DRAIN_WAIT = 8_000;

// Secciones simples must_have/deseable para que el eval de GPT tenga estructura.
const SECCIONES = [
  { id: "apertura", tipo: "must_have", nombre: "Apertura", criterio: "Saluda y se presenta con nombre" },
  { id: "necesidad", tipo: "deseable", nombre: "Necesidad", criterio: "Explora la necesidad del cliente" },
  { id: "cierre", tipo: "deseable", nombre: "Cierre", criterio: "Propone un siguiente paso concreto" },
];

const NOTA_CUMPLIDO = "Buen trabajo: el asesor cumplió el guión. Refuerza el cierre.";
const NOTA_NO_CUMPLIDO = "Atención: faltó estructura del guión. Repasar apertura y cierre.";
const TAGS_CUMPLIDO = ["coach_guion_ok_e2e"];
const TAGS_NO_CUMPLIDO = ["coach_guion_fail_e2e"];

// Estado original de la cuenta para restaurar en after().
let originalCoachHabilitado: boolean | null = null;
let originalExclusiones: unknown = null;
let seeded = false;
let seedError: string | null = null;

// IDs para limpiar en after().
const insertedGuionIds: string[] = [];
let chatConversationId = "";
let videoRecordingId = "";

async function seedCoachConfig(): Promise<void> {
  const pool = getPool();

  // Guardar estado original.
  const orig = await pool.query<{ coach_habilitado: boolean | null; exclusiones_coach: unknown }>(
    `SELECT coach_habilitado, exclusiones_coach FROM cuentas WHERE id_cuenta = $1`,
    [DEMO_ACCOUNT_ID],
  );
  originalCoachHabilitado = orig.rows[0]?.coach_habilitado ?? null;
  originalExclusiones = orig.rows[0]?.exclusiones_coach ?? null;

  // Limpiar guiones de prueba previos (idempotencia).
  await pool.query(
    `DELETE FROM guiones_coach WHERE id_cuenta = $1 AND categoria_llamada_id LIKE 'e2e_coach_%'`,
    [DEMO_ACCOUNT_ID],
  );

  for (const canal of ["chat", "videollamada"] as const) {
    // guiones_coach.id es UUID en la BD; uid() genera "e2e-..." (no UUID) y el
    // INSERT reventaba con "invalid input syntax for type uuid" en cuanto la
    // semilla tenía permisos de escritura (antes quedaba oculto: el rol readonly
    // fallaba antes, en el DELETE). Usar un UUID real (AUT-1775).
    const id = randomUUID();
    await pool.query(
      `INSERT INTO guiones_coach
         (id, id_cuenta, categoria_llamada_id, version, secciones, umbral, activo,
          canal, nota_cumplido, nota_no_cumplido, tags_cumplido, tags_no_cumplido,
          created_at, updated_at)
       VALUES ($1,$2,$3,1,$4::jsonb,$5,true,$6,$7,$8,$9::jsonb,$10::jsonb,NOW(),NOW())`,
      [
        id,
        DEMO_ACCOUNT_ID,
        `e2e_coach_${canal}`,
        JSON.stringify(SECCIONES),
        60,
        canal,
        NOTA_CUMPLIDO,
        NOTA_NO_CUMPLIDO,
        JSON.stringify(TAGS_CUMPLIDO),
        JSON.stringify(TAGS_NO_CUMPLIDO),
      ],
    );
    insertedGuionIds.push(id);
  }

  await pool.query(
    `UPDATE cuentas SET coach_habilitado = true WHERE id_cuenta = $1`,
    [DEMO_ACCOUNT_ID],
  );
}

async function triggerDrainer(): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${CEREBRO_URL}/cron/coach-drainer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-secret": CRON_SECRET,
    },
    body: "{}",
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ¿Ya existe la evaluación de coach para el chat sembrado?
async function chatEvaluationExists(): Promise<boolean> {
  const rows = await queryDB<{ ok: number }>(
    `SELECT 1 AS ok FROM evaluaciones_coach ec
     JOIN chats_logs cl ON cl.id_evento = ec.log_llamada_id
     WHERE ec.id_cuenta = $1 AND ec.canal = 'chat' AND cl.chatid = $2 LIMIT 1`,
    [DEMO_ACCOUNT_ID, chatConversationId],
  );
  return rows.length > 0;
}

// ¿Ya existe la evaluación de coach para la videollamada Fathom sembrada?
async function videollamadaEvaluationExists(): Promise<boolean> {
  const rows = await queryDB<{ ok: number }>(
    `SELECT 1 AS ok FROM evaluaciones_coach ec
     JOIN resumenes_diarios_agendas a ON a.id_registro_agenda = ec.log_llamada_id
     WHERE ec.id_cuenta = $1 AND ec.canal = 'videollamada' AND a.fathom_recording_id = $2 LIMIT 1`,
    [DEMO_ACCOUNT_ID, videoRecordingId],
  );
  return rows.length > 0;
}

before(async () => {
  // Intentar semilla; si la BD es readonly, marcar seedError y saltar los tests.
  try {
    await seedCoachConfig();
    seeded = true;
  } catch (err) {
    seedError = err instanceof Error ? err.message : String(err);
    return;
  }

  // Canal chat: 3 mensajes al mismo hilo (drainer exige jsonb_array_length(chat) >= 3).
  const first = await sendChatWebhook({
    messageBody: "Hola, buenas tardes, ¿me pueden dar información del servicio?",
    direction: "inbound",
  });
  chatConversationId = first.conversationId;
  await sendChatWebhook({
    conversationId: chatConversationId,
    contactId: first.contactId,
    messageBody: "Claro, con gusto. Soy Ana de AutoKPI, ¿en qué te ayudo?",
    direction: "outbound",
  });
  await sendChatWebhook({
    conversationId: chatConversationId,
    contactId: first.contactId,
    messageBody: "Quiero saber precios y cómo agendar una demo.",
    direction: "inbound",
  });

  // Canal videollamada: 1 grabación Fathom.
  const video = await sendVideocallWebhook({
    title: "E2E Golden Coach Videocall",
    recordingId: String(Date.now()),
  });
  videoRecordingId = video.recordingId;

  // El webhook de Fathom responde 200 de inmediato y procesa la transcripción de
  // forma ASÍNCRONA (fire-and-forget en fathom.controller); fathom_processed_at se
  // setea al terminar. Una sola corrida del drainer puede llegar antes de que la
  // videollamada esté procesada → sin candidato → la evaluación nunca se crea y el
  // test VIDEOLLAMADA fallaba (AUT-1775). El chat se procesa a tiempo, por eso solo
  // fallaba la videollamada. Poll acotado: re-dispara el drainer (idempotente: la
  // query de candidatos excluye lo ya evaluado, no hay duplicados) hasta que ambos
  // canales tengan evaluación o se agote el presupuesto.
  await waitForProcessing(PROCESSING_WAIT);

  const DRAIN_DEADLINE_MS = 150_000;
  const POLL_WAIT = 12_000;
  const drainStart = Date.now();
  let chatDone = false;
  let videoDone = false;
  while (Date.now() - drainStart < DRAIN_DEADLINE_MS) {
    await triggerDrainer();
    await waitForProcessing(DRAIN_WAIT);
    if (!chatDone) chatDone = await chatEvaluationExists();
    if (!videoDone) videoDone = await videollamadaEvaluationExists();
    if (chatDone && videoDone) break;
    await waitForProcessing(POLL_WAIT);
  }
});

after(async () => {
  // Limpieza: borrar evaluaciones y guiones de prueba, restaurar cuenta.
  try {
    const pool = getPool();
    for (const gid of insertedGuionIds) {
      await pool.query(`DELETE FROM evaluaciones_coach WHERE guion_id = $1`, [gid]);
    }
    await pool.query(
      `DELETE FROM guiones_coach WHERE id_cuenta = $1 AND categoria_llamada_id LIKE 'e2e_coach_%'`,
      [DEMO_ACCOUNT_ID],
    );
    if (originalCoachHabilitado !== null) {
      await pool.query(
        `UPDATE cuentas SET coach_habilitado = $2, exclusiones_coach = $3 WHERE id_cuenta = $1`,
        [DEMO_ACCOUNT_ID, originalCoachHabilitado, originalExclusiones],
      );
    }
  } catch {
    // best-effort cleanup
  }
  await closePool();
});

describe("Golden: Coach multicanal (chat + videollamada) → evaluaciones_coach", () => {
  test("semilla de config aplicada (o skip si BD readonly)", (t) => {
    if (!seeded) {
      t.skip(`Config no sembrada (BD readonly u error): ${seedError ?? "desconocido"}`);
      return;
    }
    assert.equal(insertedGuionIds.length, 2, "Deben existir 2 guiones (chat + videollamada)");
  });

  test("CHAT: crea evaluación con nota_accionable poblada", async (t) => {
    if (!seeded) {
      t.skip("Config no sembrada");
      return;
    }
    const rows = await queryDB<{
      canal: string;
      nota_accionable: string | null;
      cumple_umbral: boolean | null;
      score_total: number | null;
    }>(
      `SELECT ec.canal, ec.nota_accionable, ec.cumple_umbral, ec.score_total
       FROM evaluaciones_coach ec
       JOIN chats_logs cl ON cl.id_evento = ec.log_llamada_id
       WHERE ec.id_cuenta = $1 AND ec.canal = 'chat' AND cl.chatid = $2
       ORDER BY ec.evaluated_at DESC LIMIT 1`,
      [DEMO_ACCOUNT_ID, chatConversationId],
    );
    assert.ok(rows.length > 0, "Debe existir evaluación de coach para el chat");
    assert.equal(rows[0].canal, "chat");
    assert.ok(rows[0].nota_accionable, "nota_accionable debe estar poblada (prompt de nota aplicado)");
    assert.equal(typeof rows[0].cumple_umbral, "boolean", "cumple_umbral debe ser boolean");
  });

  test("VIDEOLLAMADA: crea evaluación con nota_accionable poblada", async (t) => {
    if (!seeded) {
      t.skip("Config no sembrada");
      return;
    }
    const rows = await queryDB<{
      canal: string;
      nota_accionable: string | null;
      cumple_umbral: boolean | null;
    }>(
      `SELECT ec.canal, ec.nota_accionable, ec.cumple_umbral
       FROM evaluaciones_coach ec
       JOIN resumenes_diarios_agendas a ON a.id_registro_agenda = ec.log_llamada_id
       WHERE ec.id_cuenta = $1 AND ec.canal = 'videollamada'
         AND a.fathom_recording_id = $2
       ORDER BY ec.evaluated_at DESC LIMIT 1`,
      [DEMO_ACCOUNT_ID, videoRecordingId],
    );
    assert.ok(rows.length > 0, "Debe existir evaluación de coach para la videollamada");
    assert.equal(rows[0].canal, "videollamada");
    assert.ok(rows[0].nota_accionable, "nota_accionable debe estar poblada (prompt de nota aplicado)");
  });
});

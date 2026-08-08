/**
 * E2E local del Coach de ventas por etapa (categorias_leads[].coach).
 *
 * No toca prod ni la BD: reusa las piezas REALES del pipeline con datos
 * inventados. El LLM sí es real (usa OPENAI_API_KEY de .env).
 *
 * Ejecutar:
 *   node --import tsx/esm --env-file=.env scripts/e2e-coach-demo.ts
 *
 * Flujo probado:
 *  1. matchCategoriaLead → la etiqueta del contacto resuelve su etapa.
 *  2. Interacciones inventadas (chat + llamada + cita) unidas por contacto.
 *  3. evaluateReglas → reglas de etiquetas del test aplican sobre el conjunto.
 *  4. evaluateStageCoach (LLM real) → decide pasó / no pasó con score.
 *  5. decideCoachOutcome → tags a poner/quitar + nota que iría a GHL.
 */
import {
  matchCategoriaLead,
  type CategoriaLead,
  type CoachEtapaLead,
} from "../src/services/ghl-api.service.js";
import { evaluateReglas } from "../src/services/ai/reglas-evaluator.service.js";
import {
  buildContextTranscript,
  evaluateStageCoach,
  decideCoachOutcome,
  type Interaccion,
  type StageCoachResult,
} from "../src/services/ai/stage-coach-evaluation.service.js";

// ── Cuenta demo ──────────────────────────────────────────────────────────────
const ID_CUENTA_DEMO = 52;
const RAW_KEY = process.env.OPENAI_API_KEY || "";
// El .env del repo trae un placeholder (sk-REEMPLAZAR…); solo corremos el LLM
// real si la key parece de verdad.
const REAL_KEY = /^sk-/.test(RAW_KEY) && !/REEMPLAZAR|placeholder|xxxx/i.test(RAW_KEY) ? RAW_KEY : null;

const sep = (t: string) => console.log(`\n${"─".repeat(72)}\n${t}\n${"─".repeat(72)}`);

// ── 1. Primera categoría/etapa de la cuenta demo (con coach + reglas) ─────────
const COACH_LEAD_NUEVO: CoachEtapaLead = {
  secciones: [
    { id: "apertura", nombre: "Presentación", criterio: "El asesor se presentó con nombre y empresa y saludó al lead.", tipo: "must_have" },
    { id: "descubrimiento", nombre: "Descubrimiento", criterio: "Se hizo al menos una pregunta para entender la necesidad o dolor del lead.", tipo: "must_have" },
    { id: "agenda", nombre: "Siguiente paso agendado", criterio: "Se propuso un siguiente paso concreto con fecha y hora (zoom, llamada o cita).", tipo: "must_have" },
    { id: "compromiso", nombre: "Compromiso del lead", criterio: "El lead aceptó o quedó comprometido con ese siguiente paso.", tipo: "must_have" },
  ],
  umbral: 75,
  nota_cumplido: "Felicita brevemente al asesor y recuérdale confirmar la cita.",
  nota_no_cumplido: "Indica exactamente qué sección faltó y cómo cerrarla la próxima vez.",
  tags_cumplido: ["etapa_lead_nuevo_ok"],
  tags_no_cumplido: ["etapa_lead_nuevo_pendiente"],
};

const CATEGORIAS_LEADS: CategoriaLead[] = [
  {
    id: "lead-nuevo-demo",
    nombre: "Lead nuevo — primer contacto",
    etiqueta: "lead_nuevo_demo",
    prompt: "Evalúa cada interacción con foco en calificar y agendar el siguiente paso.",
    reglas_etiquetas: [
      { id: "r1", tag: "pidio_precio", condition: "el lead preguntó por precios, costos o cuánto vale" },
      { id: "r2", tag: "menciono_competencia", condition: "el lead mencionó a un competidor u otra empresa que está evaluando" },
    ],
    coach: COACH_LEAD_NUEVO,
  },
];

// ── 2. Datos inventados ───────────────────────────────────────────────────────
const CONTACT_OK = "demo-contact-OK";
const CONTACT_OK_TAGS = ["lead_nuevo_demo"]; // tiene la etiqueta de la etapa
const CONTACT_SIN_ETAPA_TAGS = ["cliente_antiguo"]; // NO matchea ninguna etapa

// Contacto que SÍ debería cumplir (presenta, descubre, agenda, lead acepta)
const INTERACCIONES_OK: Interaccion[] = [
  {
    canal: "chat",
    ts: new Date("2026-08-06T14:30:00Z"),
    texto:
      "Lead: Hola, vi su anuncio de marketing digital.\n" +
      "Asesor: ¡Hola Andrea! Soy Camilo de LeadMaster, un gusto. ¿Qué te llamó la atención del anuncio?\n" +
      "Lead: Quiero más clientes para mi clínica dental, pero no sé por dónde empezar.\n" +
      "Asesor: Perfecto, justo ayudamos a clínicas con eso. ¿Cuánto valen sus servicios? Digo, para dimensionar.\n" +
      "Lead: Y ustedes ¿cuánto cobran por el servicio?",
  },
  {
    canal: "llamada",
    ts: new Date("2026-08-07T16:00:00Z"),
    texto:
      "Asesor: Andrea, soy Camilo de LeadMaster de nuevo. ¿Tienes un minuto?\n" +
      "Lead: Sí, claro.\n" +
      "Asesor: Cuéntame, ¿cuántos pacientes nuevos te gustaría atender al mes y qué has intentado antes?\n" +
      "Lead: Unos 20 más. Probé Instagram sola pero sin resultados. Estuve mirando también a la agencia DentalBoost.\n" +
      "Asesor: Entiendo. Te propongo algo: agendemos un Zoom el viernes 8 de agosto a las 3:00 pm y te muestro un plan concreto para tu clínica. ¿Te sirve?\n" +
      "Lead: Sí, el viernes a las 3 me queda perfecto.\n" +
      "Asesor: Listo, te llega la invitación. Nos vemos el viernes.",
  },
];

// Contacto que NO debería cumplir: presenta y descubre, pero NUNCA propone ni
// agenda un siguiente paso con fecha (fallan los criterios 3 y 4).
const INTERACCIONES_FAIL: Interaccion[] = [
  {
    canal: "chat",
    ts: new Date("2026-08-06T10:00:00Z"),
    texto:
      "Lead: Hola, quiero info de sus servicios de marketing.\n" +
      "Asesor: ¡Hola! Soy Camilo de LeadMaster. Con gusto. ¿A qué se dedica tu negocio?\n" +
      "Lead: Tengo una barbería y quiero llenar la agenda entre semana.\n" +
      "Asesor: Buenísimo. Nosotros manejamos campañas para eso. Te paso info y cualquier cosa me escribes.\n" +
      "Lead: Ok, gracias. Lo reviso y te aviso.",
  },
];

// ── Runner ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🧪 E2E Coach por etapa — cuenta demo #${ID_CUENTA_DEMO}`);
  console.log(`   OPENAI_API_KEY: ${REAL_KEY ? REAL_KEY.slice(0, 6) + "…(real → LLM en vivo)" : "(placeholder/ausente → PASOS 3-4 SIMULADOS)"}`);

  // 1. Resolución de etapa por etiqueta ---------------------------------------
  sep("PASO 1 · La etiqueta del contacto resuelve su etapa (matchCategoriaLead)");
  const etapaOk = matchCategoriaLead(CONTACT_OK_TAGS, CATEGORIAS_LEADS);
  const etapaSin = matchCategoriaLead(CONTACT_SIN_ETAPA_TAGS, CATEGORIAS_LEADS);
  console.log(`  Contacto con tag ${JSON.stringify(CONTACT_OK_TAGS)} → etapa: ${etapaOk ? `"${etapaOk.nombre}" ✅` : "sin etapa ❌"}`);
  console.log(`  Contacto con tag ${JSON.stringify(CONTACT_SIN_ETAPA_TAGS)} → etapa: ${etapaSin ? `"${etapaSin.nombre}"` : "sin etapa ✅ (correcto: no debe evaluar coach)"}`);
  if (!etapaOk) { console.error("  ✖ La etapa no resolvió; abortando."); process.exit(1); }
  console.log(`  Coach configurado en la etapa: ${etapaOk.coach ? "sí 🎯" : "no"} (umbral ${etapaOk.coach?.umbral}%)`);

  // 2. Contexto combinado por contacto ----------------------------------------
  sep("PASO 2 · Interacciones del contacto unidas por contact_id (chat + llamada)");
  const transcript = buildContextTranscript(INTERACCIONES_OK);
  console.log(transcript);

  // 3. Reglas de etiquetas sobre el conjunto ----------------------------------
  sep(`PASO 3 · Reglas de etiquetas de la etapa (evaluateReglas${REAL_KEY ? ", LLM real" : ", SIMULADO"})`);
  const reglas = etapaOk.reglas_etiquetas ?? [];
  console.log(`  Reglas de la etapa: ${reglas.map((r) => `${r.tag} ← "${r.condition}"`).join("  |  ")}`);
  if (REAL_KEY) {
    try {
      const reglasResult = await evaluateReglas(transcript, reglas, "chat", null, REAL_KEY, ID_CUENTA_DEMO);
      console.log(`  🏷️  Tags que se aplicarían: ${reglasResult.matched_tags.length ? reglasResult.matched_tags.join(", ") : "(ninguna)"}`);
    } catch (err) {
      console.error("  ✖ Error evaluando reglas:", err instanceof Error ? err.message : err);
    }
  } else {
    // Simulación determinista: en el contexto el lead pregunta precio y menciona
    // a un competidor (DentalBoost) → ambas condiciones se cumplen.
    console.log(`  🏷️  Tags que se aplicarían (SIMULADO): pidio_precio, menciono_competencia`);
  }

  // 4. Coach de IA sobre el conjunto ------------------------------------------
  sep(`PASO 4 · Coach de ventas de la etapa (evaluateStageCoach${REAL_KEY ? ", LLM real" : ", SIMULADO"})`);
  let result: StageCoachResult;
  if (REAL_KEY) {
    try {
      result = await evaluateStageCoach(transcript, etapaOk.coach!, etapaOk.nombre, REAL_KEY, ID_CUENTA_DEMO);
    } catch (err) {
      console.error("  ✖ Error en el coach IA:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  } else {
    // Resultado plausible de un LLM para este contexto (cumple los 4 puntos).
    result = {
      paso: true,
      score: 88,
      secciones_faltantes_must_have: [],
      evidencia: "El asesor se presentó (Camilo/LeadMaster), indagó la meta (20 pacientes/mes) y agendó un Zoom el viernes 3pm que la lead aceptó.",
      nota_accionable: "Confirmar la cita con recordatorio 24h antes y preparar un caso de éxito de otra clínica dental para el Zoom.",
    };
  }
  console.log(`  Resultado: ${result.paso ? "✅ PASÓ" : "⚠️ NO pasó"}  ·  score ${result.score}%  (umbral ${etapaOk.coach!.umbral}%)`);
  console.log(`  Evidencia: ${result.evidencia}`);
  console.log(`  Recomendación: ${result.nota_accionable}`);

  // 5. Tags + nota que irían a GHL en 1 contacto (primera evaluación) ----------
  sep("PASO 5 · Qué se escribiría en GHL para 1 contacto (decideCoachOutcome)");
  const outcome = decideCoachOutcome(result, etapaOk.coach!, etapaOk.nombre, /*contactTags*/ CONTACT_OK_TAGS);
  console.log(`  Contacto: ${CONTACT_OK}`);
  console.log(`  changed: ${outcome.changed}`);
  console.log(`  🏷️  tags a AÑADIR:  ${outcome.tagsToAdd.join(", ") || "(ninguna)"}`);
  console.log(`  🏷️  tags a QUITAR:  ${outcome.tagsToRemove.join(", ") || "(ninguna)"}`);
  console.log(`  📝 Nota GHL:\n${outcome.noteBody.split("\n").map((l) => "     " + l).join("\n")}`);

  // Idempotencia: si el contacto YA tuviera el tag de resultado, no re-notifica.
  const yaConTag = decideCoachOutcome(result, etapaOk.coach!, etapaOk.nombre, [
    ...CONTACT_OK_TAGS,
    ...(result.paso ? etapaOk.coach!.tags_cumplido! : etapaOk.coach!.tags_no_cumplido!),
  ]);
  sep("PASO 6 · Idempotencia (misma evaluación, contacto ya en ese estado)");
  console.log(`  changed: ${yaConTag.changed}  → ${yaConTag.changed ? "re-aplicaría (inesperado)" : "no re-notifica ✅"}`);

  // Transición: el contacto tenía el tag OK, pero una nueva evaluación falla.
  sep("PASO 7 · Transición de estado (antes OK, ahora NO cumple)");
  const resultFail: StageCoachResult = {
    paso: false,
    score: 40,
    secciones_faltantes_must_have: ["Siguiente paso agendado", "Compromiso del lead"],
    evidencia: "Hubo presentación y descubrimiento, pero no se propuso ni se acordó un siguiente paso con fecha.",
    nota_accionable: "Cerrar cada interacción proponiendo un día y hora concretos y confirmando el compromiso del lead.",
  };
  const outcomeFail = decideCoachOutcome(resultFail, etapaOk.coach!, etapaOk.nombre, ["lead_nuevo_demo", "etapa_lead_nuevo_ok"]);
  console.log(`  Nueva evaluación: ⚠️ NO pasó (${resultFail.score}%)`);
  console.log(`  🏷️  tags a AÑADIR:  ${outcomeFail.tagsToAdd.join(", ") || "(ninguna)"}`);
  console.log(`  🏷️  tags a QUITAR:  ${outcomeFail.tagsToRemove.join(", ") || "(ninguna)"}  ← transición limpia el estado anterior`);
  console.log(`  changed: ${outcomeFail.changed}`);

  // 8. Caso negativo REAL: ¿el coach rechaza lo que no debe pasar? -------------
  sep(`PASO 8 · Caso negativo — el coach debe RECHAZAR (evaluateStageCoach${REAL_KEY ? ", LLM real" : ", SIMULADO"})`);
  console.log("  Contexto: el asesor presenta y descubre, pero NUNCA agenda un siguiente paso.");
  if (REAL_KEY) {
    const transcriptFail = buildContextTranscript(INTERACCIONES_FAIL);
    let rFail: StageCoachResult;
    try {
      rFail = await evaluateStageCoach(transcriptFail, etapaOk.coach!, etapaOk.nombre, REAL_KEY, ID_CUENTA_DEMO);
    } catch (err) {
      console.error("  ✖ Error en el coach IA:", err instanceof Error ? err.message : err);
      return;
    }
    const ok = rFail.paso === false;
    console.log(`  Resultado: ${rFail.paso ? "✅ PASÓ (INESPERADO ✗)" : "⚠️ NO pasó (CORRECTO ✅)"}  ·  score ${rFail.score}%  (umbral ${etapaOk.coach!.umbral}%)`);
    console.log(`  Evidencia: ${rFail.evidencia}`);
    console.log(`  Recomendación: ${rFail.nota_accionable}`);
    console.log(`  → El coach ${ok ? "DISCRIMINA bien (rechazó el caso incompleto) ✅" : "NO discriminó (revisar prompt/umbral) ✗"}`);
  } else {
    console.log("  (omitido: sin key real)");
  }

  console.log("\n✅ E2E completado.\n");
}

main().catch((err) => { console.error(err); process.exit(1); });

import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { sql } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { cuentas } from "../../db/schema.js";
import { env } from "../../config/env.js";

interface MetricaRE {
  id: string;
  nombre: string;
  descripcion: string;
  tipo: string;
  paneles: string[];
  orden: number;
  formato: string;
  color: string;
  webhookCampo?: string;
  atribuible_a_usuario?: boolean;
  formula?: { tipo: string; fuente?: string; fuentes?: string[] };
  visualizacion?: string;
}

const PLANTILLA_RE: MetricaRE[] = [
  { id: "re-leads-semana", nombre: "Leads nuevos (semana)", descripcion: "Nuevos leads generados en la semana por asesor", tipo: "webhook", paneles: ["panel_ejecutivo"], orden: 30, formato: "numero", color: "blue", webhookCampo: "re_leads_nuevos", atribuible_a_usuario: true },
  { id: "re-leads-mes", nombre: "Leads nuevos (mes)", descripcion: "Nuevos leads acumulados en el mes", tipo: "webhook", paneles: ["panel_ejecutivo"], orden: 31, formato: "numero", color: "blue", webhookCampo: "re_leads_mes", atribuible_a_usuario: true },
  { id: "re-perfilamiento", nombre: "Leads perfilados", descripcion: "Leads que completaron perfilamiento (llamada o videollamada)", tipo: "automatica", paneles: ["panel_ejecutivo"], orden: 32, formato: "numero", color: "cyan", formula: { tipo: "directo", fuente: "meetingsAttended" } },
  { id: "re-recorridos-agendados", nombre: "Recorridos agendados", descripcion: "Tours inmobiliarios agendados en el período (vía n8n)", tipo: "webhook", paneles: ["panel_ejecutivo", "rendimiento"], orden: 34, formato: "numero", color: "purple", webhookCampo: "re_recorridos_agendados", atribuible_a_usuario: true },
  { id: "re-recorridos-realizados", nombre: "Recorridos realizados", descripcion: "Tours inmobiliarios completados (vía n8n)", tipo: "webhook", paneles: ["panel_ejecutivo", "rendimiento"], orden: 35, formato: "numero", color: "purple", webhookCampo: "re_recorridos_realizados", atribuible_a_usuario: true },
  { id: "re-recorridos-cancelados", nombre: "Recorridos cancelados", descripcion: "Tours cancelados o no presentados (vía n8n)", tipo: "webhook", paneles: ["rendimiento"], orden: 36, formato: "numero", color: "red", webhookCampo: "re_recorridos_cancelados", atribuible_a_usuario: true },
  { id: "re-apartados", nombre: "Apartados", descripcion: "Propiedades apartadas o reservadas (vía n8n)", tipo: "webhook", paneles: ["panel_ejecutivo", "rendimiento"], orden: 37, formato: "numero", color: "amber", webhookCampo: "re_apartados", atribuible_a_usuario: true },
  { id: "re-monto-apartados", nombre: "Monto apartados", descripcion: "Valor total de propiedades apartadas (vía n8n)", tipo: "webhook", paneles: ["panel_ejecutivo", "rendimiento"], orden: 38, formato: "moneda", color: "green", webhookCampo: "re_monto_apartados", atribuible_a_usuario: true },
  { id: "re-comision-apartados", nombre: "Comisión por apartados", descripcion: "Comisión estimada sobre propiedades apartadas (vía n8n)", tipo: "webhook", paneles: ["rendimiento"], orden: 39, formato: "moneda", color: "green", webhookCampo: "re_comision_apartados", atribuible_a_usuario: true },
  { id: "re-tasa-lead-perfilado", nombre: "Conversión Lead → Perfilado", descripcion: "% de leads que completaron perfilamiento", tipo: "automatica", paneles: ["panel_ejecutivo"], orden: 40, formato: "porcentaje", color: "cyan", formula: { tipo: "division", fuentes: ["re-perfilamiento", "re-leads-mes"] } },
  { id: "re-tasa-perfilado-recorrido", nombre: "Conversión Perfilado → Recorrido", descripcion: "% de perfilados que hicieron recorrido", tipo: "automatica", paneles: ["panel_ejecutivo"], orden: 41, formato: "porcentaje", color: "purple", formula: { tipo: "division", fuentes: ["re-recorridos-realizados", "re-perfilamiento"] } },
  { id: "re-tasa-recorrido-apartado", nombre: "Conversión Recorrido → Apartado", descripcion: "% de recorridos que terminaron en apartado", tipo: "automatica", paneles: ["panel_ejecutivo"], orden: 42, formato: "porcentaje", color: "amber", formula: { tipo: "division", fuentes: ["re-apartados", "re-recorridos-realizados"] } },
  { id: "re-ranking-comisiones", nombre: "Ranking por comisiones", descripcion: "Comisión mensual acumulada por asesor (vía n8n)", tipo: "webhook", paneles: ["rendimiento"], orden: 43, formato: "moneda", color: "green", webhookCampo: "re_comision_mensual", atribuible_a_usuario: true, visualizacion: "barra" },
  { id: "re-horas-capacitacion", nombre: "Horas de capacitación", descripcion: "Horas de entrenamiento completadas (integración GHL/n8n)", tipo: "webhook", paneles: ["rendimiento"], orden: 44, formato: "decimal", color: "blue", webhookCampo: "re_horas_capacitacion", atribuible_a_usuario: true },
  { id: "re-actividad-vencida", nombre: "Actividad vencida", descripcion: "Oportunidades sin seguimiento en los últimos N días (vía n8n)", tipo: "webhook", paneles: ["rendimiento"], orden: 45, formato: "numero", color: "red", webhookCampo: "re_actividad_vencida", atribuible_a_usuario: true },
];

const RE_IDS = new Set(PLANTILLA_RE.map((m) => m.id));

const OLD_METRICAS_IDS_DEMO = new Set([
  "3100472b-74e6-4c1b-a1c2-19af92addc28",
  "a585b8f1-0dde-4ed0-b09c-41af7ec65ce3",
  "d8648fcf-4715-404d-b032-597f2af90886",
]);

const OLD_METRICAS_IDS_SERENTHYS = new Set([
  "2c1ebcf5-5d46-494a-b4ea-4ea82963d66a",
]);

interface CuentaRow {
  id_cuenta: number;
  nombre_cuenta: string | null;
  metricas_config: unknown;
}

interface BackfillResult {
  id_cuenta: number;
  nombre: string | null;
  metricas_agregadas: number;
  metricas_reemplazadas: number;
  skipped: boolean;
}

export async function backfillMetricasReRoute(app: FastifyInstance) {
  app.post<{
    Body: { solo_cuenta?: number; dry_run?: boolean };
  }>(
    "/backfill-metricas-re",
    {
      schema: {
        headers: Type.Object({ "x-cron-secret": Type.String() }),
        body: Type.Object({
          solo_cuenta: Type.Optional(Type.Number()),
          dry_run: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (request, reply) => {
      const secret = request.headers["x-cron-secret"];
      if (secret !== env.CRON_SECRET) {
        return reply.status(401).send({ success: false, error: "Unauthorized" });
      }

      const { solo_cuenta, dry_run } = request.body;

      let rows: CuentaRow[];
      if (solo_cuenta) {
        rows = await drizzleDb
          .select({
            id_cuenta: cuentas.id_cuenta,
            nombre_cuenta: cuentas.nombre_cuenta,
            metricas_config: cuentas.metricas_config,
          })
          .from(cuentas)
          .where(sql`${cuentas.id_cuenta} = ${solo_cuenta}`)
          .limit(1);
      } else {
        rows = await drizzleDb
          .select({
            id_cuenta: cuentas.id_cuenta,
            nombre_cuenta: cuentas.nombre_cuenta,
            metricas_config: cuentas.metricas_config,
          })
          .from(cuentas)
          .where(sql`${cuentas.estado_cuenta} = 'activo'`);
      }

      const results: BackfillResult[] = [];

      for (const row of rows) {
        const existing = Array.isArray(row.metricas_config)
          ? (row.metricas_config as MetricaRE[])
          : [];

        const existingIds = new Set(existing.map((m) => m.id));

        let cleaned = existing;
        let replaced = 0;

        if (row.id_cuenta === 52) {
          const before = cleaned.length;
          cleaned = cleaned.filter((m) => !OLD_METRICAS_IDS_DEMO.has(m.id));
          replaced = before - cleaned.length;
        } else if (row.id_cuenta === 18) {
          const before = cleaned.length;
          cleaned = cleaned.filter((m) => !OLD_METRICAS_IDS_SERENTHYS.has(m.id));
          replaced = before - cleaned.length;
        }

        const cleanedIds = new Set(cleaned.map((m) => m.id));
        const toAdd = PLANTILLA_RE.filter((m) => !cleanedIds.has(m.id));

        if (toAdd.length === 0 && replaced === 0) {
          results.push({
            id_cuenta: row.id_cuenta,
            nombre: row.nombre_cuenta,
            metricas_agregadas: 0,
            metricas_reemplazadas: 0,
            skipped: true,
          });
          continue;
        }

        const updated = [...cleaned, ...toAdd];

        if (!dry_run) {
          await drizzleDb
            .update(cuentas)
            .set({ metricas_config: sql`${JSON.stringify(updated)}::jsonb` })
            .where(sql`${cuentas.id_cuenta} = ${row.id_cuenta}`);
        }

        results.push({
          id_cuenta: row.id_cuenta,
          nombre: row.nombre_cuenta,
          metricas_agregadas: toAdd.length,
          metricas_reemplazadas: replaced,
          skipped: false,
        });
      }

      const modified = results.filter((r) => !r.skipped);

      return reply.send({
        success: true,
        dry_run: dry_run ?? false,
        total_cuentas: rows.length,
        cuentas_modificadas: modified.length,
        cuentas_sin_cambios: results.filter((r) => r.skipped).length,
        detalle: results,
      });
    },
  );
}

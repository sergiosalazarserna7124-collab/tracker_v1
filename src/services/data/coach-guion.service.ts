import { and, eq, desc } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { guionesCoach, cuentas, evaluacionesCoach } from "../../db/schema.js";

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface SeccionGuion {
  id: string;
  nombre: string;
  criterio: string;
  tipo: "must_have" | "deseable";
}

export type CanalCoach = "llamada" | "chat" | "videollamada";

export interface GuionCoach {
  id: string;
  id_cuenta: number;
  categoria_llamada_id: string;
  canal: CanalCoach;
  version: number;
  secciones: SeccionGuion[];
  umbral: number;
  activo: boolean;
  nota_cumplido: string | null;
  nota_no_cumplido: string | null;
  tags_cumplido: string[] | null;
  tags_no_cumplido: string[] | null;
  created_at: Date | null;
  updated_at: Date | null;
}

export interface UpsertGuionPayload {
  categoria_llamada_id: string;
  canal?: CanalCoach;
  secciones: SeccionGuion[];
  umbral?: number;
  nota_cumplido?: string | null;
  nota_no_cumplido?: string | null;
  tags_cumplido?: string[] | null;
  tags_no_cumplido?: string[] | null;
}

// ─── Validación ──────────────────────────────────────────────────────────────

const TIPOS_VALIDOS = new Set(["must_have", "deseable"]);
const CANALES_VALIDOS = new Set<CanalCoach>(["llamada", "chat", "videollamada"]);

export function validateSecciones(secciones: unknown): SeccionGuion[] {
  if (!Array.isArray(secciones) || secciones.length === 0) {
    throw new Error("secciones debe ser un array no vacío");
  }

  const ids = new Set<string>();
  const result: SeccionGuion[] = [];

  for (const s of secciones) {
    if (typeof s !== "object" || s === null) {
      throw new Error("Cada sección debe ser un objeto");
    }
    const sec = s as Record<string, unknown>;

    if (typeof sec.id !== "string" || sec.id.trim() === "") {
      throw new Error("id de sección requerido");
    }
    if (typeof sec.nombre !== "string" || sec.nombre.trim() === "") {
      throw new Error("nombre de sección requerido");
    }
    if (typeof sec.criterio !== "string" || sec.criterio.trim() === "") {
      throw new Error("criterio de sección requerido");
    }
    if (typeof sec.tipo !== "string" || !TIPOS_VALIDOS.has(sec.tipo)) {
      throw new Error(`tipo debe ser must_have o deseable, recibido: ${String(sec.tipo)}`);
    }

    const id = sec.id.trim();
    if (ids.has(id)) {
      throw new Error(`id de sección duplicado: "${id}"`);
    }
    ids.add(id);

    result.push({
      id,
      nombre: (sec.nombre as string).trim(),
      criterio: (sec.criterio as string).trim(),
      tipo: sec.tipo as "must_have" | "deseable",
    });
  }

  return result;
}

// ─── Operaciones de BD ──────────────────────────────────────────────────────

export async function getGuionesByCuenta(idCuenta: number): Promise<GuionCoach[]> {
  const rows = await drizzleDb
    .select()
    .from(guionesCoach)
    .where(and(eq(guionesCoach.id_cuenta, idCuenta), eq(guionesCoach.activo, true)))
    .orderBy(guionesCoach.categoria_llamada_id, desc(guionesCoach.version));

  return rows.map(mapRow);
}

export async function getGuionByCategoria(
  idCuenta: number,
  categoriaLlamadaId: string,
  canal: CanalCoach = "llamada",
): Promise<GuionCoach | null> {
  const [row] = await drizzleDb
    .select()
    .from(guionesCoach)
    .where(
      and(
        eq(guionesCoach.id_cuenta, idCuenta),
        eq(guionesCoach.categoria_llamada_id, categoriaLlamadaId),
        eq(guionesCoach.canal, canal),
        eq(guionesCoach.activo, true),
      ),
    )
    .orderBy(desc(guionesCoach.version))
    .limit(1);

  return row ? mapRow(row) : null;
}

export async function upsertGuion(
  idCuenta: number,
  payload: UpsertGuionPayload,
): Promise<GuionCoach> {
  const secciones = validateSecciones(payload.secciones);
  const canal = payload.canal ?? "llamada";
  if (!CANALES_VALIDOS.has(canal)) {
    throw new Error(`canal debe ser llamada, chat o videollamada, recibido: ${canal}`);
  }
  const umbral = payload.umbral ?? 70;
  if (umbral < 0 || umbral > 100) {
    throw new Error("umbral debe estar entre 0 y 100");
  }

  const existing = await getGuionByCategoria(idCuenta, payload.categoria_llamada_id, canal);

  if (existing) {
    await drizzleDb
      .update(guionesCoach)
      .set({ activo: false })
      .where(eq(guionesCoach.id, existing.id));

    // Reconciliación: eliminar evaluaciones de la versión anterior para que
    // el drainer re-evalúe esas llamadas con el guion actualizado.
    const deleted = await drizzleDb
      .delete(evaluacionesCoach)
      .where(eq(evaluacionesCoach.guion_id, existing.id))
      .returning({ id: evaluacionesCoach.id });

    if (deleted.length > 0) {
      console.info(
        `[upsertGuion] Reconciliación: eliminadas ${deleted.length} evaluaciones del guion ${existing.id} (v${existing.version}) para re-evaluación`,
      );
    }
  }

  const newVersion = existing ? existing.version + 1 : 1;

  const [inserted] = await drizzleDb
    .insert(guionesCoach)
    .values({
      id_cuenta: idCuenta,
      categoria_llamada_id: payload.categoria_llamada_id,
      canal,
      version: newVersion,
      secciones: secciones as unknown as Record<string, unknown>,
      umbral,
      activo: true,
      nota_cumplido: payload.nota_cumplido ?? null,
      nota_no_cumplido: payload.nota_no_cumplido ?? null,
      tags_cumplido: (payload.tags_cumplido ?? null) as unknown as Record<string, unknown>,
      tags_no_cumplido: (payload.tags_no_cumplido ?? null) as unknown as Record<string, unknown>,
    })
    .returning();

  return mapRow(inserted);
}

export async function deleteGuion(
  idCuenta: number,
  categoriaLlamadaId: string,
): Promise<boolean> {
  const result = await drizzleDb
    .update(guionesCoach)
    .set({ activo: false, updated_at: new Date() })
    .where(
      and(
        eq(guionesCoach.id_cuenta, idCuenta),
        eq(guionesCoach.categoria_llamada_id, categoriaLlamadaId),
        eq(guionesCoach.activo, true),
      ),
    )
    .returning({ id: guionesCoach.id });

  return result.length > 0;
}

export async function isCoachHabilitado(idCuenta: number): Promise<boolean> {
  const [row] = await drizzleDb
    .select({ coach_habilitado: cuentas.coach_habilitado })
    .from(cuentas)
    .where(eq(cuentas.id_cuenta, idCuenta))
    .limit(1);

  return row?.coach_habilitado ?? false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapRow(row: typeof guionesCoach.$inferSelect): GuionCoach {
  return {
    id: row.id,
    id_cuenta: row.id_cuenta,
    categoria_llamada_id: row.categoria_llamada_id,
    canal: row.canal as CanalCoach,
    version: row.version,
    secciones: row.secciones as unknown as SeccionGuion[],
    umbral: row.umbral,
    activo: row.activo,
    nota_cumplido: row.nota_cumplido,
    nota_no_cumplido: row.nota_no_cumplido,
    tags_cumplido: row.tags_cumplido as unknown as string[] | null,
    tags_no_cumplido: row.tags_no_cumplido as unknown as string[] | null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

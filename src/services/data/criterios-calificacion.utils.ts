/**
 * Utilidades puras para criterios de calificación — sin dependencias de BD.
 * Separadas para permitir tests sin necesidad de variables de entorno.
 *
 * AUT-413: criterios de calificación configurables por cuenta.
 * AUT-1327: criterios por canal (chats, llamadas, videollamadas).
 */

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type Canal = "chats" | "llamadas" | "videollamadas";

export interface CriteriosCanal {
  categorias_calificadas: string[];
  umbral_minimo: number;
}

export interface CriteriosCalificacion {
  /** Categorías de ia_categoria que cuentan como lead calificado */
  categorias_calificadas: string[];
  /** Mínimo de categorías calificadas que debe tener el chat para ser es_calificado=true */
  umbral_minimo: number;
  /** Criterios específicos por canal — opcionales */
  canales?: {
    chats?: CriteriosCanal;
    llamadas?: CriteriosCanal;
    videollamadas?: CriteriosCanal;
  };
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

const CANALES_VALIDOS: readonly Canal[] = ["chats", "llamadas", "videollamadas"];

function parseCriteriosCanal(raw: unknown, label: string): CriteriosCanal {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`canales.${label} debe ser un objeto`);
  }
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.categorias_calificadas)) {
    throw new Error(`canales.${label}.categorias_calificadas debe ser un array de strings`);
  }
  for (const cat of obj.categorias_calificadas as unknown[]) {
    if (typeof cat !== "string" || cat.trim() === "") {
      throw new Error(`Cada elemento de canales.${label}.categorias_calificadas debe ser un string no vacío`);
    }
  }

  const umbral = obj.umbral_minimo;
  if (umbral !== undefined && (typeof umbral !== "number" || !Number.isInteger(umbral) || umbral < 1)) {
    throw new Error(`canales.${label}.umbral_minimo debe ser un entero positivo`);
  }

  return {
    categorias_calificadas: (obj.categorias_calificadas as string[]).map((s) => s.trim()),
    umbral_minimo: typeof umbral === "number" ? umbral : 1,
  };
}

// ─── Helper de validación ─────────────────────────────────────────────────────

/**
 * Valida y normaliza un payload de criterios_calificacion.
 * Acepta tanto la estructura legacy (solo global) como la nueva (con canales).
 * Lanza un Error descriptivo si la estructura no es válida.
 */
export function parseCriteriosCalificacion(raw: unknown): CriteriosCalificacion {
  if (raw === null || raw === undefined) {
    throw new Error("El payload no puede ser null o undefined");
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("criterios_calificacion debe ser un objeto");
  }
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.categorias_calificadas)) {
    throw new Error("categorias_calificadas debe ser un array de strings");
  }
  for (const cat of obj.categorias_calificadas as unknown[]) {
    if (typeof cat !== "string" || cat.trim() === "") {
      throw new Error("Cada elemento de categorias_calificadas debe ser un string no vacío");
    }
  }

  const umbral = obj.umbral_minimo;
  if (umbral !== undefined && (typeof umbral !== "number" || !Number.isInteger(umbral) || umbral < 1)) {
    throw new Error("umbral_minimo debe ser un entero positivo");
  }

  const result: CriteriosCalificacion = {
    categorias_calificadas: (obj.categorias_calificadas as string[]).map((s) => s.trim()),
    umbral_minimo: typeof umbral === "number" ? umbral : 1,
  };

  if (obj.canales !== undefined) {
    if (typeof obj.canales !== "object" || obj.canales === null || Array.isArray(obj.canales)) {
      throw new Error("canales debe ser un objeto");
    }
    const canalesRaw = obj.canales as Record<string, unknown>;
    const unknownKeys = Object.keys(canalesRaw).filter(
      (k) => !(CANALES_VALIDOS as readonly string[]).includes(k),
    );
    if (unknownKeys.length > 0) {
      throw new Error(`canales contiene claves no válidas: ${unknownKeys.join(", ")}`);
    }

    const canales: CriteriosCalificacion["canales"] = {};
    for (const canal of CANALES_VALIDOS) {
      if (canalesRaw[canal] !== undefined) {
        canales[canal] = parseCriteriosCanal(canalesRaw[canal], canal);
      }
    }
    if (Object.keys(canales).length > 0) {
      result.canales = canales;
    }
  }

  return result;
}

// ─── Lógica de calificación ───────────────────────────────────────────────────

/**
 * Resuelve los criterios efectivos: si hay criterios por canal y se especifica
 * un canal, usa esos; si no, usa los globales.
 */
export function resolverCriterios(
  criterios: CriteriosCalificacion,
  canal?: Canal,
): CriteriosCanal {
  if (canal && criterios.canales?.[canal]) {
    return criterios.canales[canal];
  }
  return {
    categorias_calificadas: criterios.categorias_calificadas,
    umbral_minimo: criterios.umbral_minimo,
  };
}

/**
 * Determina si un chat/llamada/videollamada es calificado según los criterios.
 *
 * - criterios = null → es_calificado: true siempre (backward compat)
 * - criterios definido + canal → usa criterios del canal si existen, sino global
 * - criterios definido sin canal → usa criterios globales
 */
export function esCalificado(
  iaCategoria: string | null,
  criterios: CriteriosCalificacion | null,
  canal?: Canal,
): boolean {
  if (criterios === null) return true;
  if (iaCategoria === null) return false;
  const efectivos = resolverCriterios(criterios, canal);
  return efectivos.categorias_calificadas.includes(iaCategoria);
}

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

export interface CategoriaCustom {
  slug: string;
  label: string;
  descripcion: string;
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
  /** Categorías custom definidas por el tenant (AUT-1526) */
  categorias_custom?: CategoriaCustom[];
  prompt_calificacion_chats?: string | null;
}

// ─── Defaults por canal ──────────────────────────────────────────────────────
// AUT-1659: cuando criterios_calificacion es NULL, aplicamos defaults razonables
// en vez de marcar todo como calificado. Cada canal tiene sus propias categorías
// que cuentan como "calificado" según lo que la IA puede clasificar.

export const DEFAULTS_POR_CANAL: Record<Canal, CriteriosCanal> = {
  chats: {
    categorias_calificadas: ["calificada", "interesado", "cerrada"],
    umbral_minimo: 1,
  },
  llamadas: {
    categorias_calificadas: [
      "calificada", "cerrada", "interesado",
      "agendado", "reagendado", "confirmado",
    ],
    umbral_minimo: 1,
  },
  videollamadas: {
    categorias_calificadas: ["calificada", "cerrada"],
    umbral_minimo: 1,
  },
};

export const CRITERIOS_DEFAULT: CriteriosCalificacion = {
  categorias_calificadas: ["calificada", "cerrada", "interesado"],
  umbral_minimo: 1,
  canales: { ...DEFAULTS_POR_CANAL },
};

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

  if (obj.categorias_custom !== undefined) {
    if (!Array.isArray(obj.categorias_custom)) {
      throw new Error("categorias_custom debe ser un array");
    }
    const slugs = new Set<string>();
    for (const item of obj.categorias_custom as unknown[]) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error("Cada categoría custom debe ser un objeto con slug, label y descripcion");
      }
      const cat = item as Record<string, unknown>;
      if (typeof cat.slug !== "string" || cat.slug.trim() === "") {
        throw new Error("slug de categoría custom debe ser un string no vacío");
      }
      if (typeof cat.label !== "string" || cat.label.trim() === "") {
        throw new Error("label de categoría custom debe ser un string no vacío");
      }
      if (typeof cat.descripcion !== "string") {
        throw new Error("descripcion de categoría custom debe ser un string");
      }
      const slug = cat.slug.trim();
      if (slugs.has(slug)) {
        throw new Error(`slug duplicado en categorias_custom: "${slug}"`);
      }
      slugs.add(slug);
    }
    result.categorias_custom = (obj.categorias_custom as Array<Record<string, unknown>>).map((c) => ({
      slug: (c.slug as string).trim(),
      label: (c.label as string).trim(),
      descripcion: (c.descripcion as string).trim(),
    }));
  }

  if (obj.prompt_calificacion_chats !== undefined && obj.prompt_calificacion_chats !== null) {
    if (typeof obj.prompt_calificacion_chats !== "string") {
      throw new Error("prompt_calificacion_chats debe ser un string o null");
    }
    const trimmed = (obj.prompt_calificacion_chats as string).trim();
    if (trimmed.length > 0) {
      result.prompt_calificacion_chats = trimmed;
    }
  }

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
 * Aplica umbral_minimo: el lead debe cumplir >= umbral_minimo categorías
 * calificadas. Con umbral_minimo=1 (default) basta con que una categoría
 * coincida (mismo comportamiento anterior). Acepta string o string[] para
 * soportar leads con múltiples categorías.
 */
export function esCalificado(
  iaCategoria: string | string[] | null,
  criterios: CriteriosCalificacion | null,
  canal?: Canal,
  calificacionManual?: string | null,
): boolean {
  if (calificacionManual === "calificado") return true;
  if (calificacionManual === "descartado") return false;
  if (iaCategoria === null) return false;
  const efectivos = resolverCriterios(criterios ?? CRITERIOS_DEFAULT, canal);
  const categorias = Array.isArray(iaCategoria) ? iaCategoria : [iaCategoria];
  const coincidencias = categorias.filter((c) =>
    efectivos.categorias_calificadas.includes(c),
  ).length;
  return coincidencias >= efectivos.umbral_minimo;
}

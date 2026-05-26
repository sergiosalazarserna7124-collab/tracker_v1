/**
 * Utilidades puras para criterios de calificación — sin dependencias de BD.
 * Separadas para permitir tests sin necesidad de variables de entorno.
 *
 * AUT-413: criterios de calificación configurables por cuenta.
 */

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CriteriosCalificacion {
  /** Categorías de ia_categoria que cuentan como lead calificado */
  categorias_calificadas: string[];
  /** Mínimo de categorías calificadas que debe tener el chat para ser es_calificado=true */
  umbral_minimo: number;
}

// ─── Helper de validación ─────────────────────────────────────────────────────

/**
 * Valida y normaliza un payload de criterios_calificacion.
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

  return {
    categorias_calificadas: (obj.categorias_calificadas as string[]).map((s) => s.trim()),
    umbral_minimo: typeof umbral === "number" ? umbral : 1,
  };
}

// ─── Lógica de calificación ───────────────────────────────────────────────────

/**
 * Determina si un chat es calificado según los criterios de la cuenta.
 *
 * - criterios = null → es_calificado: true siempre (backward compat)
 * - criterios definido → true si ia_categoria está en categorias_calificadas
 *
 * TODO(AUT-413): umbral_minimo se valida y persiste pero no se aplica aquí.
 * Cada chat_log tiene una sola ia_categoria; contar categorías por conversación
 * requeriría agregación a nivel de contacto, fuera del scope de este feature.
 */
export function esCalificado(
  iaCategoria: string | null,
  criterios: CriteriosCalificacion | null,
): boolean {
  if (criterios === null) return true;
  if (iaCategoria === null) return false;
  return criterios.categorias_calificadas.includes(iaCategoria);
}

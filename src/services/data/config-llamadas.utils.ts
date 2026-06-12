export interface ConfigLlamadas {
  min_palabras: number;
  requiere_conversacion_real: boolean;
}

const DEFAULT_MIN_PALABRAS = 15;

export function parseConfigLlamadas(raw: unknown): ConfigLlamadas | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;

  const minPalabras =
    typeof obj.min_palabras === "number" && Number.isInteger(obj.min_palabras) && obj.min_palabras > 0
      ? obj.min_palabras
      : DEFAULT_MIN_PALABRAS;

  const requiereConversacionReal =
    typeof obj.requiere_conversacion_real === "boolean"
      ? obj.requiere_conversacion_real
      : true;

  return { min_palabras: minPalabras, requiere_conversacion_real: requiereConversacionReal };
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

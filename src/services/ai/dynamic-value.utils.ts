export interface DynamicValueRange {
  min: number;
  label: string;
}

export interface DynamicValueConfig {
  fuente: "custom_field" | "formula";
  fieldId?: string;
  formula?: string;
  tipo?: "numero" | "si_no" | "texto" | "fecha";
  ranges?: DynamicValueRange[];
  labelSi?: string;
  labelNo?: string;
}

export function resolveRangeLabel(value: number, ranges: DynamicValueRange[]): string {
  const sorted = [...ranges].sort((a, b) => b.min - a.min);
  for (const r of sorted) {
    if (value >= r.min) return r.label;
  }
  return sorted.at(-1)?.label ?? String(value);
}

export function resolveBooleanLabel(raw: unknown, labelSi?: string, labelNo?: string): string {
  const s = String(raw).toLowerCase().trim();
  const truthy = s === "true" || s === "yes" || s === "sí" || s === "si" || s === "1";
  return truthy ? (labelSi ?? "Sí") : (labelNo ?? "No");
}

export function inferTipo(config: DynamicValueConfig): DynamicValueConfig["tipo"] {
  if (config.ranges?.length) return "numero";
  return "texto";
}

export function resolveCustomFieldValue(
  config: DynamicValueConfig,
  rawValue: string,
  fieldValue: unknown,
): string {
  const tipo = config.tipo ?? inferTipo(config);

  switch (tipo) {
    case "numero": {
      const num = parseFloat(rawValue);
      if (isNaN(num)) return rawValue;
      if (config.ranges?.length) return resolveRangeLabel(num, config.ranges);
      return String(num);
    }
    case "si_no":
      return resolveBooleanLabel(fieldValue, config.labelSi, config.labelNo);
    case "fecha":
      return rawValue;
    case "texto":
    default:
      return rawValue;
  }
}

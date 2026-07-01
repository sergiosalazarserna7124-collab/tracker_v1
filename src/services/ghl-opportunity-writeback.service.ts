import {
  searchOpportunityByContact,
  getOpportunityById,
  updateOpportunityCustomFields,
} from "./ghl-api.service.js";

export interface OpportunityFieldsConfig {
  enabled: boolean;
  tipo_de_interes_field_key?: string;
  razon_de_no_calificado_field_key?: string;
  max_chars?: number;
}

function parseConfig(raw: unknown): OpportunityFieldsConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const cfg = raw as Record<string, unknown>;
  if (cfg.enabled !== true) return null;
  return {
    enabled: true,
    tipo_de_interes_field_key: typeof cfg.tipo_de_interes_field_key === "string" ? cfg.tipo_de_interes_field_key : undefined,
    razon_de_no_calificado_field_key: typeof cfg.razon_de_no_calificado_field_key === "string" ? cfg.razon_de_no_calificado_field_key : undefined,
    max_chars: typeof cfg.max_chars === "number" ? cfg.max_chars : 255,
  };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + "...";
}

export function buildOpportunityFieldValues(
  estadoFinal: string,
  analysisText: string | null,
  iadesc: string | null,
  config: OpportunityFieldsConfig,
): Array<{ id: string; field_value: string }> | null {
  const maxChars = config.max_chars ?? 255;

  const CALIFICADOS = ["calificado", "interesado", "agendado", "reagendado", "venta"];
  const NO_CALIFICADOS = ["no_calificado", "no_interesado", "sin_interes", "rechazado"];

  const estadoLower = estadoFinal.toLowerCase();
  const isCalificado = CALIFICADOS.includes(estadoLower);
  const isNoCalificado = NO_CALIFICADOS.includes(estadoLower);

  if (!isCalificado && !isNoCalificado) return null;

  const sourceText = analysisText ?? iadesc;
  if (!sourceText) return null;

  if (isCalificado && config.tipo_de_interes_field_key) {
    return [{ id: config.tipo_de_interes_field_key, field_value: truncate(sourceText, maxChars) }];
  }

  if (isNoCalificado && config.razon_de_no_calificado_field_key) {
    return [{ id: config.razon_de_no_calificado_field_key, field_value: truncate(sourceText, maxChars) }];
  }

  return null;
}

export async function writebackOpportunityFields(opts: {
  contactId: string;
  locationId: string;
  tokenGhl: string;
  estadoFinal: string;
  analysisText: string | null;
  iadesc: string | null;
  rawConfig: unknown;
  label: string;
}): Promise<void> {
  const { contactId, locationId, tokenGhl, estadoFinal, analysisText, iadesc, rawConfig, label } = opts;

  const config = parseConfig(rawConfig);
  if (!config) return;

  const fieldsToWrite = buildOpportunityFieldValues(estadoFinal, analysisText, iadesc, config);
  if (!fieldsToWrite || fieldsToWrite.length === 0) return;

  try {
    const oppId = await searchOpportunityByContact(contactId, locationId, tokenGhl);
    if (!oppId) {
      console.info(`${label} Opp writeback: no opportunity found for contact=${contactId}`);
      return;
    }

    const opp = await getOpportunityById(oppId, tokenGhl);
    if (opp?.customFields) {
      const nonEmpty = fieldsToWrite.filter((f) => {
        const existing = opp.customFields?.find((cf) => cf.id === f.id);
        return !existing?.fieldValue;
      });
      if (nonEmpty.length === 0) {
        console.info(`${label} Opp writeback: fields already populated for opp=${oppId}, skipping (idempotency)`);
        return;
      }
      fieldsToWrite.length = 0;
      fieldsToWrite.push(...nonEmpty);
    }

    await updateOpportunityCustomFields(oppId, tokenGhl, fieldsToWrite);
    console.info(`${label} Opp writeback: wrote ${fieldsToWrite.length} field(s) to opp=${oppId}`);
  } catch (err) {
    console.error(`${label} Opp writeback error (fail-open):`, err);
  }
}

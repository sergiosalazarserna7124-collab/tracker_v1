import { Type, type Static } from "@sinclair/typebox";

// ─── Params ───────────────────────────────────────────────────────────────────

export const ExternalDataParams = Type.Object({
  locationid: Type.String({ minLength: 1 }),
});

export type ExternalDataParamsType = Static<typeof ExternalDataParams>;

// ─── Body ─────────────────────────────────────────────────────────────────────

const MetricaItem = Type.Object({
  // fecha es opcional — si no se envía, el servicio usa la fecha de hoy en la TZ de la cuenta.
  // Esto permite que el workflow de GHL no tenga que hardcodear la fecha.
  fecha: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
  metricas: Type.Record(Type.String(), Type.Any()),
  origen: Type.Optional(Type.String()),
});

export type MetricaItemType = Static<typeof MetricaItem>;

export const ExternalDataBody = Type.Object({
  data: Type.Array(MetricaItem, { minItems: 1 }),
});

export type ExternalDataBodyType = Static<typeof ExternalDataBody>;

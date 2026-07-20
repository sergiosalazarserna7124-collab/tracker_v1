import { Type, type Static } from "@sinclair/typebox";

export const MetricasWebhookParams = Type.Object({
  locationid: Type.String({ minLength: 1 }),
});

export type MetricasWebhookParamsType = Static<typeof MetricasWebhookParams>;

export const MetricasWebhookBody = Type.Object(
  {},
  { additionalProperties: true },
);

export type MetricasWebhookBodyType = Record<string, unknown>;

import { Type, type Static } from "@sinclair/typebox";

export const CronHeaders = Type.Object(
  {
    "x-cron-secret": Type.String({ minLength: 1 }),
  },
  { additionalProperties: true },
);

export const CronDailyTasksBody = Type.Object({
  event: Type.String({ minLength: 1 }),
  target_date: Type.String({
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    description: "Fecha en formato YYYY-MM-DD",
  }),
  account_ids: Type.Array(Type.Number({ minimum: 1 }), { minItems: 1 }),
});

export type CronDailyTasksPayload = Static<typeof CronDailyTasksBody>;

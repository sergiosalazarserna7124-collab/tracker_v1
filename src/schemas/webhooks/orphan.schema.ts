import { Type, type Static } from "@sinclair/typebox";

// ─── Params ───────────────────────────────────────────────────────────────────

export const OrphanParams = Type.Object({
  id_huerfano: Type.String({ minLength: 1 }),
});

export type OrphanParamsType = Static<typeof OrphanParams>;

// ─── Body ─────────────────────────────────────────────────────────────────────

export const OrphanRetryBody = Type.Object({
  email_corregido: Type.String({ format: "email", minLength: 1 }),
});

export type OrphanRetryBodyType = Static<typeof OrphanRetryBody>;

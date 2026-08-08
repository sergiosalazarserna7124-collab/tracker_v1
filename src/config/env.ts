import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import "dotenv/config";

const EnvSchema = Type.Object({
  PORT: Type.String({ default: "8080" }),
  NODE_ENV: Type.Union(
    [Type.Literal("development"), Type.Literal("production"), Type.Literal("test")],
    { default: "development" },
  ),
  DATABASE_URL: Type.String({ minLength: 1 }),
  // Credencial dedicada con permisos DDL para el runner de migraciones (AUT-1688).
  // Si no está seteada, el runner cae a DATABASE_URL (comportamiento actual → cero regresión).
  MIGRATIONS_DATABASE_URL: Type.String({ default: "" }),
  CRON_SECRET: Type.String({ minLength: 1 }),
  OPENAI_API_KEY: Type.String({ minLength: 1 }),
  GHL_APP_CLIENT_ID: Type.String({ default: "" }),
  GHL_APP_CLIENT_SECRET: Type.String({ default: "" }),
  GHL_OAUTH_REDIRECT_URI: Type.String({ default: "" }),
  GEMINI_API_KEY: Type.String({ default: "" }),
  // Minutos entre corridas del loop interno de reconciliación de llamadas GHL.
  // "0" = desactivado (default): las no contestadas llegan por la etiqueta
  // "no-contestada" (workflow Call Status); este loop queda como plan B.
  GHL_CALLS_RECONCILE_MIN: Type.String({ default: "0" }),
  // Minutos entre barridos automáticos de no-shows (cita PDTE con ≥5h desde
  // la reunión y sin Fathom → verificar en GHL → no_show). "0" lo desactiva.
  NO_SHOWS_SWEEP_MIN: Type.String({ default: "30" }),
});

export type Env = Static<typeof EnvSchema>;

function loadEnv(): Env {
  const raw = {
    PORT: process.env.PORT ?? "8080",
    NODE_ENV: process.env.NODE_ENV ?? "development",
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    MIGRATIONS_DATABASE_URL: process.env.MIGRATIONS_DATABASE_URL ?? "",
    CRON_SECRET: process.env.CRON_SECRET ?? "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
    // App del Marketplace oficial (appId 6a74c60076292fcda6ad92a1). El client_id
    // no es secreto; el SECRET debe venir del env (Cloud Run), nunca hardcodeado.
    GHL_APP_CLIENT_ID: process.env.GHL_APP_CLIENT_ID ?? "6a74c60076292fcda6ad92a1-msklreih",
    GHL_APP_CLIENT_SECRET: process.env.GHL_APP_CLIENT_SECRET ?? "",
    GHL_OAUTH_REDIRECT_URI: process.env.GHL_OAUTH_REDIRECT_URI ?? "https://cerebro-tracker-v6-saas-git-cstkjl7bpa-ue.a.run.app/oauth/callback",
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "",
    GHL_CALLS_RECONCILE_MIN: process.env.GHL_CALLS_RECONCILE_MIN ?? "0",
    NO_SHOWS_SWEEP_MIN: process.env.NO_SHOWS_SWEEP_MIN ?? "30",
  };

  if (!Value.Check(EnvSchema, raw)) {
    const errors = [...Value.Errors(EnvSchema, raw)];
    const formatted = errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
    throw new Error(`Invalid environment variables:\n${formatted}`);
  }

  return raw;
}

export const env = loadEnv();

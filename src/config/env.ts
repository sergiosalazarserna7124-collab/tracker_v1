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
  CRON_SECRET: Type.String({ minLength: 1 }),
  OPENAI_API_KEY: Type.String({ minLength: 1 }),
});

export type Env = Static<typeof EnvSchema>;

function loadEnv(): Env {
  const raw = {
    PORT: process.env.PORT ?? "8080",
    NODE_ENV: process.env.NODE_ENV ?? "development",
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    CRON_SECRET: process.env.CRON_SECRET ?? "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  };

  if (!Value.Check(EnvSchema, raw)) {
    const errors = [...Value.Errors(EnvSchema, raw)];
    const formatted = errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
    throw new Error(`Invalid environment variables:\n${formatted}`);
  }

  return raw;
}

export const env = loadEnv();

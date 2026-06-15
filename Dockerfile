# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:22-slim AS builder

# Activa corepack y fija la misma versión de pnpm que generó el lockfile.
# IMPORTANTE: debe coincidir con "packageManager" en package.json y con
# lockfileVersion: '9.0' del pnpm-lock.yaml para que --frozen-lockfile no falle.
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

WORKDIR /app

# Copiar manifiestos primero → Docker cachea esta capa si no cambian
COPY package.json pnpm-lock.yaml ./

# Instalar TODAS las dependencias (incluidas devDeps: TypeScript, tsx, etc.)
RUN pnpm install --frozen-lockfile

# Copiar código fuente, migraciones SQL y compilar
COPY tsconfig.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/
RUN pnpm run build

# Reinstalar solo dependencias de producción (elimina devDeps del node_modules)
RUN pnpm install --frozen-lockfile --prod

# ── Stage 2: Runtime mínimo ──────────────────────────────────────────────────
# Imagen distroless: sin shell, sin apt, sin usuarios innecesarios.
# Solo contiene Node.js 22 + las librerías del sistema necesarias.
FROM gcr.io/distroless/nodejs22-debian12

WORKDIR /app

COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/migrations   ./migrations

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Cloud Run inyecta las env vars (DATABASE_URL, OPENAI_API_KEY, CRON_SECRET)
# directamente en el contenedor; no se necesita .env en producción.
CMD ["dist/server.js"]

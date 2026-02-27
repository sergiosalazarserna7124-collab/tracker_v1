/**
 * Retry genérico para operaciones de BD u otras que fallen
 * por errores de conexión transitorios (frecuentes en Cloud Run).
 *
 * Solo reintenta cuando el error es de red/conexión reconocido;
 * errores lógicos (constraint violations, syntax, etc.) se propagan
 * inmediatamente sin gastar reintentos.
 */

const RETRYABLE_PATTERNS = [
  "Connection terminated",
  "connection timeout",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "socket hang up",
  "Client has encountered a connection error",
] as const;

// Drizzle envuelve el error de pg en DrizzleQueryError donde .message es
// "Failed query: SELECT..." y el error real de conexión está en .cause.
// Recorremos toda la cadena err → err.cause → err.cause.cause para
// encontrar el patrón retryable en cualquier nivel.
function isRetryableError(err: unknown): boolean {
  let current: unknown = err;
  while (current) {
    const msg = current instanceof Error ? current.message : String(current);
    if (RETRYABLE_PATTERNS.some((p) => msg.includes(p))) return true;
    current =
      current instanceof Error && current.cause !== current
        ? current.cause
        : undefined;
  }
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; delayMs?: number; label?: string } = {},
): Promise<T> {
  const { retries = 2, delayMs = 1_000, label = "DB" } = opts;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableError(err) || attempt > retries) throw err;

      const wait = delayMs * attempt;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[${label}] Attempt ${attempt}/${retries + 1} failed (${msg}); retrying in ${wait}ms…`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  throw new Error("Unreachable");
}

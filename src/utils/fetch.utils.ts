/**
 * Wrapper de fetch con timeout automático via AbortController.
 * Lanza un AbortError si la solicitud excede timeoutMs milisegundos,
 * lo cual será capturado por los bloques try/catch de los servicios
 * y tratado como un fallo de red (activando el fallback correspondiente).
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

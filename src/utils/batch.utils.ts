/**
 * Procesa un array en lotes (chunks) con una pausa entre cada uno.
 *
 * Dentro de cada lote las promesas corren en paralelo (Promise.all).
 * Entre lote y lote se espera `delayMs` milisegundos para no saturar
 * APIs con rate limits como GoHighLevel (~10 req/s recomendado).
 *
 * Ejemplo: 150 contactos con chunkSize=10 y delayMs=500
 *   → 15 lotes × 10 req simultáneas, pausa 500ms entre lotes
 *   → ~8 segundos total en vez de 150 requests en 1ms (→ 429)
 *
 * @param items     Array de elementos a procesar
 * @param chunkSize Tamaño de cada lote
 * @param delayMs   Pausa en milisegundos entre lotes
 * @param fn        Función async a ejecutar por cada elemento
 * @returns         Array de resultados en el mismo orden que `items`
 */
export async function processInChunks<T, R>(
  items: T[],
  chunkSize: number,
  delayMs: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const chunkResults = await Promise.all(chunk.map(fn));
    results.push(...chunkResults);

    const hasMore = i + chunkSize < items.length;
    if (hasMore) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

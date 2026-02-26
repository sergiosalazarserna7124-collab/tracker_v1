const MESES_ES: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

/**
 * Convierte un tiempo local (year/month/day/hour/min) en un timezone IANA
 * al instante UTC equivalente.
 *
 * Algoritmo (sin librerías externas, Node 22 / V8 Intl):
 *  1. Crea una Date "ingenua" tratando el tiempo local como si fuera UTC.
 *  2. Usa Intl.DateTimeFormat para ver qué hora local muestra esa fecha UTC
 *     en el timezone objetivo (esto nos da el offset real, DST incluido).
 *  3. Calcula la diferencia y la aplica en sentido inverso.
 *
 * Ejemplo: 08:00 en "America/Bogota" (UTC-5)
 *   → naive = 2026-02-23T08:00:00Z
 *   → Intl formatea naive en Bogota → 03:00 (porque 08:00 UTC = 03:00 Bogota)
 *   → offset = 08:00 − 03:00 = +5h
 *   → resultado = 08:00Z + 5h = 2026-02-23T13:00:00Z ✓
 */
function ianaLocalToUTC(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date | null {
  try {
    const naive = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(naive);

    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));

    // Algunos locales formatean medianoche como "24" en vez de "00"
    const parsedHour = parseInt(p.hour) === 24 ? 0 : parseInt(p.hour);

    const tzAsUTC = new Date(
      Date.UTC(
        parseInt(p.year),
        parseInt(p.month) - 1,
        parseInt(p.day),
        parsedHour,
        parseInt(p.minute),
        parseInt(p.second),
      ),
    );

    const offsetMs = naive.getTime() - tzAsUTC.getTime();
    return new Date(naive.getTime() + offsetMs);
  } catch {
    return null;
  }
}

/**
 * Parsea una fecha en formato español con hora y la convierte a UTC.
 *
 * Formato esperado: "DD de MES de YYYY HH:MM"
 * Ejemplo: "23 de febrero de 2026 8:00" con zonahoraria "America/Bogota"
 * Resultado: 2026-02-23T13:00:00.000Z
 *
 * Soporta cualquier timezone IANA válido (America/Bogota, Europe/Madrid,
 * America/Buenos_Aires, America/New_York, etc.) y respeta el DST automáticamente.
 *
 * @param hora         - "23 de febrero de 2026 8:00"
 * @param zonahoraria  - timezone IANA: "America/Bogota", "America/Buenos_Aires", etc.
 * @returns Date en UTC, o null si el formato no pudo ser parseado
 */
export function parseFechaReunionToUTC(hora: string, zonahoraria: string): Date | null {
  if (!hora || !zonahoraria) return null;

  // Captura: DD  MES  YYYY  HH  MM
  const regex = /(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})\s+(\d{1,2}):(\d{2})/i;
  const match = hora.match(regex);
  if (!match) return null;

  const dia = parseInt(match[1]);
  const mesNombre = match[2].toLowerCase();
  const anio = parseInt(match[3]);
  const horas = parseInt(match[4]);
  const minutos = parseInt(match[5]);

  const mes = MESES_ES[mesNombre];
  if (!mes) return null;

  return ianaLocalToUTC(anio, mes, dia, horas, minutos, zonahoraria);
}

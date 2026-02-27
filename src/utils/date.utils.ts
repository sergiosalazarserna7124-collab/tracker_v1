// ─── Tablas de meses ──────────────────────────────────────────────────────────

const MESES_ES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4,
  mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

const MESES_EN: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4,
  may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
};

// ─── Normalización de timezone IANA ──────────────────────────────────────────
// GHL puede enviar "america/bogota" (todo minúsculas).
// Intl.DateTimeFormat es case-insensitive en Node ≥ 18 en la mayoría de casos,
// pero para garantizar compatibilidad, normalizamos al formato canónico
// Area/City → primera letra de cada segmento/palabra en mayúscula.
// Ej: "america/bogota" → "America/Bogota"
//     "america/new_york" → "America/New_York"
//     "america/indiana/indianapolis" → "America/Indiana/Indianapolis"

function normalizeIANA(tz: string): string {
  return tz
    .trim()
    .split("/")
    .map((segment) =>
      segment
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join("_"),
    )
    .join("/");
}

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

// ─── Parser formato español ───────────────────────────────────────────────────
// Formato: "23 de febrero de 2026 8:00"

function parseEspanol(hora: string): [number, number, number, number, number] | null {
  const regex = /(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})\s+(\d{1,2}):(\d{2})/i;
  const match = hora.match(regex);
  if (!match) return null;

  const mes = MESES_ES[match[2].toLowerCase()];
  if (!mes) return null;

  return [parseInt(match[3]), mes, parseInt(match[1]), parseInt(match[4]), parseInt(match[5])];
}

// ─── Parser formato inglés con AM/PM ─────────────────────────────────────────
// Formato: "February 27, 2026 3:00 PM"  o  "February 27, 2026 3:00PM"

function parseIngles(hora: string): [number, number, number, number, number] | null {
  const regex = /^(\w+)\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i;
  const match = hora.trim().match(regex);
  if (!match) return null;

  const mes = MESES_EN[match[1].toLowerCase()];
  if (!mes) return null;

  let horas = parseInt(match[4]);
  const minutos = parseInt(match[5]);
  const ampm = match[6].toUpperCase();

  // Conversión 12h → 24h
  if (ampm === "PM" && horas !== 12) horas += 12;
  if (ampm === "AM" && horas === 12) horas = 0;

  return [parseInt(match[3]), mes, parseInt(match[2]), horas, minutos];
}

/**
 * Parsea una fecha de reunión con hora y la convierte a UTC.
 *
 * Acepta dos formatos provenientes de GHL:
 *   • Inglés con AM/PM: "February 27, 2026 3:00 PM"  (formato actual de GHL)
 *   • Español 24h:      "27 de febrero de 2026 15:00" (formato legado)
 *
 * El timezone puede llegar en cualquier capitalización:
 *   "America/Bogota", "america/bogota", "AMERICA/BOGOTA" → todos aceptados.
 *
 * @param hora         - Fecha+hora en formato inglés o español
 * @param zonahoraria  - Timezone IANA (cualquier capitalización)
 * @returns Date en UTC, o null si el formato no pudo ser parseado
 */
export function parseFechaReunionToUTC(hora: string, zonahoraria: string): Date | null {
  if (!hora || !zonahoraria) return null;

  const tz = normalizeIANA(zonahoraria);

  // Intentar formato inglés primero (es el que envía GHL actualmente)
  const partsEn = parseIngles(hora);
  if (partsEn) {
    const result = ianaLocalToUTC(...partsEn, tz);
    if (result) return result;
  }

  // Fallback: formato español legado
  const partsEs = parseEspanol(hora);
  if (partsEs) {
    return ianaLocalToUTC(...partsEs, tz);
  }

  console.warn(`[date.utils] No se pudo parsear la fecha: "${hora}" con tz="${zonahoraria}"`);
  return null;
}

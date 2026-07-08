const LADA_MX: Record<string, string> = {
  "55": "CDMX", "56": "CDMX",
  "33": "Jalisco", "33x": "Jalisco",
  "81": "Nuevo León",
  "222": "Puebla", "221": "Puebla",
  "844": "Coahuila", "871": "Coahuila", "866": "Coahuila", "861": "Coahuila",
  "614": "Chihuahua", "656": "Chihuahua", "625": "Chihuahua", "639": "Chihuahua",
  "664": "Baja California", "686": "Baja California", "665": "Baja California", "661": "Baja California",
  "612": "Baja California Sur", "624": "Baja California Sur",
  "999": "Yucatán", "985": "Yucatán", "997": "Yucatán",
  "998": "Quintana Roo", "984": "Quintana Roo", "983": "Quintana Roo",
  "993": "Tabasco", "914": "Tabasco",
  "961": "Chiapas", "962": "Chiapas", "963": "Chiapas",
  "951": "Oaxaca", "971": "Oaxaca",
  "442": "Querétaro", "441": "Querétaro",
  "449": "Aguascalientes",
  "477": "Guanajuato", "462": "Guanajuato", "473": "Guanajuato", "461": "Guanajuato",
  "443": "Michoacán", "452": "Michoacán", "351": "Michoacán", "353": "Michoacán",
  "492": "Zacatecas",
  "444": "San Luis Potosí",
  "868": "Tamaulipas", "899": "Tamaulipas", "834": "Tamaulipas", "833": "Tamaulipas",
  "667": "Sinaloa", "669": "Sinaloa", "694": "Sinaloa",
  "662": "Sonora", "644": "Sonora", "631": "Sonora", "633": "Sonora",
  "618": "Durango",
  "311": "Nayarit",
  "312": "Colima",
  "747": "Guerrero", "744": "Guerrero", "733": "Guerrero",
  "228": "Veracruz", "229": "Veracruz", "271": "Veracruz", "272": "Veracruz",
  "771": "Hidalgo", "773": "Hidalgo",
  "246": "Tlaxcala",
  "777": "Morelos",
  "722": "Estado de México", "712": "Estado de México", "713": "Estado de México",
  "981": "Campeche",
  "969": "Tabasco",
};

const COUNTRY_CODES: Record<string, string> = {
  "1": "Estados Unidos / Canadá",
  "44": "Reino Unido",
  "34": "España",
  "57": "Colombia",
  "51": "Perú",
  "56": "Chile",
  "54": "Argentina",
  "593": "Ecuador",
  "591": "Bolivia",
  "502": "Guatemala",
  "503": "El Salvador",
  "504": "Honduras",
  "505": "Nicaragua",
  "506": "Costa Rica",
  "507": "Panamá",
  "509": "Haití",
  "58": "Venezuela",
  "55": "Brasil",
  "598": "Uruguay",
  "595": "Paraguay",
  "353": "República Dominicana",
};

export function ubicacionPorTelefono(phone: string | null | undefined): string | null {
  if (!phone) return null;

  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return null;

  if (digits.startsWith("52") && digits.length >= 12) {
    const lada = digits.slice(2);
    for (const len of [3, 2]) {
      const prefix = lada.slice(0, len);
      const estado = LADA_MX[prefix];
      if (estado) return `${estado}, México (aprox)`;
    }
    return "México (aprox)";
  }

  if (digits.startsWith("521") && digits.length >= 13) {
    const lada = digits.slice(3);
    for (const len of [3, 2]) {
      const prefix = lada.slice(0, len);
      const estado = LADA_MX[prefix];
      if (estado) return `${estado}, México (aprox)`;
    }
    return "México (aprox)";
  }

  for (const len of [3, 2, 1]) {
    const prefix = digits.slice(0, len);
    const country = COUNTRY_CODES[prefix];
    if (country) return `${country} (aprox)`;
  }

  return null;
}

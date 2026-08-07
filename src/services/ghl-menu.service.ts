/**
 * Crea el "Custom Menu Link" de Métricas dentro de GHL para que el cliente vea
 * su dashboard sin salir de la plataforma.
 *
 * Requiere los scopes `custom-menu-link.readonly` y `custom-menu-link.write`
 * en el app de GHL. Si faltan, la API responde 401 y esta función falla de forma
 * silenciosa (best-effort) sin romper el flujo de instalación.
 *
 * Docs: https://marketplace.gohighlevel.com/docs/ghl/custom-menus/create-custom-menu/
 */

const GHL_CUSTOM_MENUS_URL = "https://services.leadconnectorhq.com/custom-menus/";
const ROOT_DOMAIN = process.env.FRONTEND_ROOT_DOMAIN ?? "leadmaster.com.co";

interface CustomMenu {
  id?: string;
  url?: string;
  title?: string;
}

/**
 * Crea (si no existe) un menú "Métricas" que abre el dashboard del cliente
 * embebido dentro de GHL. Idempotente por URL.
 *
 * @param accessToken token con scope custom-menu-link.write (agencia o location)
 */
export async function ensureMetricsMenuLink(
  locationId: string,
  subdominio: string,
  accessToken: string,
): Promise<void> {
  const dashboardUrl = `https://login.${ROOT_DOMAIN}/${subdominio}`;

  // Idempotencia: si ya existe un menú apuntando a esta URL, no crear otro.
  try {
    const listRes = await fetch(
      `${GHL_CUSTOM_MENUS_URL}?locationId=${encodeURIComponent(locationId)}`,
      { headers: { Authorization: `Bearer ${accessToken}`, Version: "2021-07-28", Accept: "application/json" } },
    );
    if (listRes.ok) {
      const data = (await listRes.json()) as { customMenus?: CustomMenu[] };
      if ((data.customMenus ?? []).some((m) => m.url === dashboardUrl)) {
        console.info(`[GhlMenu] Menú "Métricas" ya existe para location=${locationId}`);
        return;
      }
    }
  } catch {
    /* best-effort: si falla el listado, intentamos crear igual */
  }

  const body = {
    title: "Métricas",
    url: dashboardUrl,
    icon: { name: "chart-line", fontFamily: "fas" },
    showOnCompany: false,
    showOnLocation: true,
    showToAllLocations: false,
    locations: [locationId],
    openMode: "iframe",
    userRole: "all",
  };

  const res = await fetch(GHL_CUSTOM_MENUS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GHL custom-menus create failed (${res.status}): ${t}`);
  }
  console.info(`[GhlMenu] Menú "Métricas" creado para location=${locationId} → ${dashboardUrl}`);
}

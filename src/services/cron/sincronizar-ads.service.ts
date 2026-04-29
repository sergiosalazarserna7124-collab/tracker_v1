import { db as pgPool } from "../../config/database.js";

// ─── Tipos ────────────────────────────────────────────────────────────────────

// Todos los campos disponibles de la API de Meta Ads Insights
export const META_ADS_FIELDS_DISPONIBLES = [
  { key: "spend", label: "Gasto total ($)", default: true },
  { key: "impressions", label: "Impresiones", default: true },
  { key: "clicks", label: "Clicks", default: true },
  { key: "cpm", label: "CPM (Costo por 1000 impresiones)", default: true },
  { key: "cpc", label: "CPC (Costo por click)", default: true },
  { key: "ctr", label: "CTR (%)", default: true },
  { key: "reach", label: "Alcance único", default: false },
  { key: "frequency", label: "Frecuencia", default: false },
  { key: "actions", label: "Acciones (leads, compras, etc.)", default: false },
  { key: "action_values", label: "Valor de acciones ($)", default: false },
  { key: "cost_per_action_type", label: "Costo por acción", default: false },
  { key: "video_play_actions", label: "Reproducciones de video", default: false },
  { key: "video_thruplay_watched_actions", label: "Video visto al 100%", default: false },
  { key: "video_30_sec_watched_actions", label: "Video visto 30 seg", default: false },
  { key: "website_ctr", label: "CTR hacia sitio web", default: false },
  { key: "outbound_clicks", label: "Clicks salientes", default: false },
  { key: "outbound_clicks_ctr", label: "CTR saliente (%)", default: false },
  { key: "inline_link_clicks", label: "Clicks en enlace", default: false },
  { key: "inline_post_engagement", label: "Engagement del post", default: false },
  { key: "post_reactions", label: "Reacciones al post", default: false },
  { key: "post_comments", label: "Comentarios", default: false },
  { key: "post_shares", label: "Compartidos", default: false },
  { key: "unique_clicks", label: "Clicks únicos", default: false },
  { key: "unique_ctr", label: "CTR único (%)", default: false },
  { key: "cost_per_unique_click", label: "Costo por click único", default: false },
] as const;

export type MetaAdsField = typeof META_ADS_FIELDS_DISPONIBLES[number]["key"];

interface AdsMetaConfig {
  activo: boolean;
  ad_account_id: string;
  access_token: string;
  cron_hora: number;
  campos_extra?: string[]; // Campos adicionales seleccionados por el usuario
  pixel_id?: string; // ID del Pixel de Meta para conversiones
}

interface AdsGoogleConfig {
  activo: boolean;
  customer_id: string;
  developer_token: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  cron_hora: number;
}

interface AdsTikTokConfig {
  activo: boolean;
  advertiser_id: string;
  access_token: string;
  cron_hora: number;
}

interface AdsVturbConfig {
  activo: boolean;
  api_token: string;
  auth_header?: string; // Nombre del header de auth (default: 'Authorization')
  nombre_player: string;
  cron_hora: number;
}

interface ConfiguracionAds {
  meta?: AdsMetaConfig;
  google?: AdsGoogleConfig;
  tiktok?: AdsTikTokConfig;
  vturb?: AdsVturbConfig;
}

interface CuentaAdsRow {
  id_cuenta: number;
  configuracion_ads: ConfiguracionAds | null;
}

interface SincronizarAdsResult {
  success: boolean;
  processed: number;
  errors: string[];
}

// ─── Helper: yesterday date string ───────────────────────────────────────────

function getYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ─── Meta Ads sync ────────────────────────────────────────────────────────────

async function sincronizarMetaAds(idCuenta: number, config: AdsMetaConfig, fecha: string): Promise<void> {
  const url = new URL(
    `https://graph.facebook.com/v19.0/act_${config.ad_account_id}/insights`,
  );
  // Campos base siempre incluidos + campos extra configurados por el usuario
  const baseFields = ["spend", "impressions", "clicks", "campaign_name", "adset_name", "cpm", "cpc", "ctr"];
  const extraFields = (config.campos_extra ?? []).filter((f) => !baseFields.includes(f));
  const allFields = [...baseFields, ...extraFields];
  url.searchParams.set("fields", allFields.join(","));
  url.searchParams.set("time_range", JSON.stringify({ since: fecha, until: fecha }));
  url.searchParams.set("level", "campaign");
  url.searchParams.set("access_token", config.access_token);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Meta API error: ${res.status} ${text}`);
  }

  const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
  const rows = json.data ?? [];

  const CAMPOS_BASE = new Set(["campaign_name", "adset_name", "spend", "impressions", "clicks", "cpm", "cpc", "ctr", "date_start", "date_stop"]);

  for (const row of rows) {
    const campana = String(row.campaign_name ?? "");
    const conjuntoAnuncios = String(row.adset_name ?? "");
    const gasto = parseFloat(String(row.spend ?? "0")) || 0;
    const impresiones = parseInt(String(row.impressions ?? "0"), 10) || 0;
    const clicks = parseInt(String(row.clicks ?? "0"), 10) || 0;
    const cpm = parseFloat(String(row.cpm ?? "0")) || 0;
    const cpc = parseFloat(String(row.cpc ?? "0")) || 0;
    const ctr = parseFloat(String(row.ctr ?? "0")) || 0;

    // Guardar campos extra en datos_extra (reach, actions, video_plays, etc.)
    const datosExtra: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(row)) {
      if (!CAMPOS_BASE.has(key)) {
        datosExtra[key] = val;
      }
    }

    await pgPool.query(
      `INSERT INTO resumenes_diarios_ads
        (id_cuenta, fecha, plataforma, campana, conjunto_anuncios, gasto_total_ad, impresiones_totales, clicks_unicos, cpm, cpc, ctr, datos_extra)
       VALUES ($1, $2, 'meta', $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id_cuenta, fecha, COALESCE(campana, ''))
       DO UPDATE SET
         gasto_total_ad = EXCLUDED.gasto_total_ad,
         impresiones_totales = EXCLUDED.impresiones_totales,
         clicks_unicos = EXCLUDED.clicks_unicos,
         cpm = EXCLUDED.cpm,
         cpc = EXCLUDED.cpc,
         ctr = EXCLUDED.ctr,
         conjunto_anuncios = EXCLUDED.conjunto_anuncios,
         datos_extra = EXCLUDED.datos_extra,
         plataforma = 'meta'`,
      [idCuenta, fecha, campana, conjuntoAnuncios, gasto, impresiones, clicks, cpm, cpc, ctr,
       Object.keys(datosExtra).length > 0 ? JSON.stringify(datosExtra) : null],
    );
  }
}

// ─── Google Ads sync ──────────────────────────────────────────────────────────

async function sincronizarGoogleAds(idCuenta: number, config: AdsGoogleConfig, fecha: string): Promise<void> {
  // Get access token via refresh token
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.client_id,
      client_secret: config.client_secret,
      refresh_token: config.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Google OAuth error: ${tokenRes.status} ${text}`);
  }

  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  const accessToken = tokenJson.access_token;
  if (!accessToken) throw new Error("Google OAuth: no access_token returned");

  const customerId = config.customer_id.replace(/-/g, "");

  const query = `
    SELECT
      campaign.name,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpm,
      metrics.average_cpc,
      segments.date
    FROM campaign
    WHERE segments.date = '${fecha}'
      AND campaign.status = 'ENABLED'
  `;

  const res = await fetch(
    `https://googleads.googleapis.com/v17/customers/${customerId}/googleAds:search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": config.developer_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Ads API error: ${res.status} ${text}`);
  }

  const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
  const rows = json.results ?? [];

  for (const row of rows) {
    const campaign = row.campaign as Record<string, unknown> | undefined;
    const metrics = row.metrics as Record<string, unknown> | undefined;
    const campana = String(campaign?.name ?? "");
    const gasto = (parseInt(String(metrics?.cost_micros ?? "0"), 10) || 0) / 1_000_000;
    const impresiones = parseInt(String(metrics?.impressions ?? "0"), 10) || 0;
    const clicks = parseInt(String(metrics?.clicks ?? "0"), 10) || 0;
    const ctr = parseFloat(String(metrics?.ctr ?? "0")) * 100 || 0;
    const cpm = parseFloat(String(metrics?.average_cpm ?? "0")) / 1_000_000 || 0;
    const cpc = parseFloat(String(metrics?.average_cpc ?? "0")) / 1_000_000 || 0;

    await pgPool.query(
      `INSERT INTO resumenes_diarios_ads
        (id_cuenta, fecha, plataforma, campana, gasto_total_ad, impresiones_totales, clicks_unicos, cpm, cpc, ctr)
       VALUES ($1, $2, 'google', $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id_cuenta, fecha)
       DO UPDATE SET
         gasto_total_ad = EXCLUDED.gasto_total_ad,
         impresiones_totales = EXCLUDED.impresiones_totales,
         clicks_unicos = EXCLUDED.clicks_unicos,
         cpm = EXCLUDED.cpm,
         cpc = EXCLUDED.cpc,
         ctr = EXCLUDED.ctr,
         campana = EXCLUDED.campana,
         plataforma = 'google'`,
      [idCuenta, fecha, campana, gasto, impresiones, clicks, cpm, cpc, ctr],
    );
  }
}

// ─── TikTok Ads sync ──────────────────────────────────────────────────────────

async function sincronizarTikTokAds(idCuenta: number, config: AdsTikTokConfig, fecha: string): Promise<void> {
  const dimensions = JSON.stringify(["campaign_id", "stat_time_day"]);
  const metrics = JSON.stringify(["spend", "impressions", "clicks", "cpm", "cpc", "ctr", "campaign_name"]);

  const params = new URLSearchParams({
    advertiser_id: config.advertiser_id,
    report_type: "BASIC",
    data_level: "AUCTION_CAMPAIGN",
    dimensions,
    metrics,
    start_date: fecha,
    end_date: fecha,
    page_size: "50",
  });

  const res = await fetch(
    `https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/?${params.toString()}`,
    {
      headers: {
        "Access-Token": config.access_token,
        "Content-Type": "application/json",
      },
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TikTok API error: ${res.status} ${text}`);
  }

  const json = (await res.json()) as {
    data?: {
      list?: Array<{ dimensions: Record<string, unknown>; metrics: Record<string, unknown> }>;
    };
  };

  const rows = json.data?.list ?? [];

  for (const row of rows) {
    const m = row.metrics;
    const campana = String(m.campaign_name ?? "");
    const gasto = parseFloat(String(m.spend ?? "0")) || 0;
    const impresiones = parseInt(String(m.impressions ?? "0"), 10) || 0;
    const clicks = parseInt(String(m.clicks ?? "0"), 10) || 0;
    const cpm = parseFloat(String(m.cpm ?? "0")) || 0;
    const cpc = parseFloat(String(m.cpc ?? "0")) || 0;
    const ctr = parseFloat(String(m.ctr ?? "0")) || 0;

    await pgPool.query(
      `INSERT INTO resumenes_diarios_ads
        (id_cuenta, fecha, plataforma, campana, gasto_total_ad, impresiones_totales, clicks_unicos, cpm, cpc, ctr)
       VALUES ($1, $2, 'tiktok', $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id_cuenta, fecha)
       DO UPDATE SET
         gasto_total_ad = EXCLUDED.gasto_total_ad,
         impresiones_totales = EXCLUDED.impresiones_totales,
         clicks_unicos = EXCLUDED.clicks_unicos,
         cpm = EXCLUDED.cpm,
         cpc = EXCLUDED.cpc,
         ctr = EXCLUDED.ctr,
         campana = EXCLUDED.campana,
         plataforma = 'tiktok'`,
      [idCuenta, fecha, campana, gasto, impresiones, clicks, cpm, cpc, ctr],
    );
  }
}

// ─── Vturb Analytics sync ────────────────────────────────────────────────────

async function sincronizarVturbAds(idCuenta: number, config: AdsVturbConfig, fecha: string): Promise<void> {
  // 1. Obtener lista de players
  const playersRes = await fetch("https://analytics.vturb.net/players/list", {
    headers: {
      "X-Api-Version": "v1",
      [config.auth_header || "x-api-token"]: config.api_token,
    },
  });
  if (!playersRes.ok) {
    throw new Error(`Vturb players error: ${playersRes.status} ${await playersRes.text()}`);
  }
  const playersRaw = (await playersRes.json()) as unknown;
  // Vturb puede retornar array directo O { data: [...] } O { players: [...] }
  let players: Array<{ id: string; name: string }> = [];
  if (Array.isArray(playersRaw)) {
    players = playersRaw as Array<{ id: string; name: string }>;
  } else if (playersRaw && typeof playersRaw === "object") {
    const obj = playersRaw as Record<string, unknown>;
    if (Array.isArray(obj.data)) players = obj.data as Array<{ id: string; name: string }>;
    else if (Array.isArray(obj.players)) players = obj.players as Array<{ id: string; name: string }>;
    else if (Array.isArray(obj.items)) players = obj.items as Array<{ id: string; name: string }>;
  }

  console.log(`[Vturb] ${players.length} players encontrados: ${players.map((p) => p.name).join(", ")}`);

  // 2. Filtrar por nombre configurado (case-insensitive, trim)
  const player = players.find(
    (p) => p.name?.trim().toLowerCase() === config.nombre_player.trim().toLowerCase(),
  );
  if (!player) {
    throw new Error(
      `Player "${config.nombre_player}" no encontrado. Disponibles: [${players.map((p) => `"${p.name}"`).join(", ")}]. ` +
      `Verifica que el nombre coincida exactamente (sensible a mayúsculas NO, a espacios SÍ).`
    );
  }

  // 3. Obtener stats del día
  const statsRes = await fetch("https://analytics.vturb.net/sessions/stats_by_day", {
    method: "POST",
    headers: {
      "X-Api-Version": "v1",
      [config.auth_header || "x-api-token"]: config.api_token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      player_id: player.id,
      start_date: `${fecha} 00:01:00`,
      end_date: `${fecha} 23:57:00`,
      timezone: "America/Bogota",
    }),
  });
  if (!statsRes.ok) {
    throw new Error(`Vturb stats error: ${statsRes.status} ${await statsRes.text()}`);
  }
  // Vturb API can return array directly OR { data: [...] }
  const statsRaw = (await statsRes.json()) as unknown;
  let data: Array<Record<string, unknown>> = [];
  if (Array.isArray(statsRaw)) {
    data = statsRaw as Array<Record<string, unknown>>;
  } else if (statsRaw && typeof statsRaw === "object") {
    const obj = statsRaw as Record<string, unknown>;
    if (Array.isArray(obj.data)) data = obj.data as Array<Record<string, unknown>>;
    else if (Array.isArray(obj.results)) data = obj.results as Array<Record<string, unknown>>;
  }
  if (data.length === 0) {
    console.log(`[Vturb] Sin datos para player "${config.nombre_player}" en fecha ${fecha}`);
    return;
  }

  // 4. Extraer métricas (misma lógica que el workflow de n8n)
  const get = (key: string): number => {
    const found = data.find((obj) => Object.prototype.hasOwnProperty.call(obj, key));
    return found ? parseFloat(String(found[key] ?? "0")) || 0 : 0;
  };

  const impresiones = get("impressions");
  const clicks = get("link_click");
  const cpm = get("CPM");
  const cpc = get("CPC");
  const ctr = get("CTR");
  const gasto = get("spend");
  const agendamientos = get("usuarios");
  // play_rate y engagement por fecha específica
  const targetRow = data.find((obj) => obj.date_key === fecha);
  const play_rate = targetRow ? parseFloat(String(targetRow.play_rate ?? "0")) || 0 : 0;
  const engagement = targetRow ? parseFloat(String(targetRow.watched_rate ?? targetRow.engagement ?? "0")) || 0 : 0;

  // Use ON CONFLICT matching the actual unique index: (id_cuenta, fecha, COALESCE(campana,''))
  // Vturb rows have no campana → campana=NULL → COALESCE='' → conflict key matches (id_cuenta, fecha, '')
  await pgPool.query(
    `INSERT INTO resumenes_diarios_ads
      (id_cuenta, fecha, plataforma, campana, gasto_total_ad, impresiones_totales, clicks_unicos, cpm, cpc, ctr, play_rate, engagement, agendamientos, datos_extra)
     VALUES ($1, $2, 'vturb', 'vturb_daily', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id_cuenta, fecha, COALESCE(campana, ''))
     DO UPDATE SET
       gasto_total_ad = EXCLUDED.gasto_total_ad,
       impresiones_totales = EXCLUDED.impresiones_totales,
       clicks_unicos = EXCLUDED.clicks_unicos,
       cpm = EXCLUDED.cpm,
       cpc = EXCLUDED.cpc,
       ctr = EXCLUDED.ctr,
       play_rate = EXCLUDED.play_rate,
       engagement = EXCLUDED.engagement,
       agendamientos = EXCLUDED.agendamientos,
       datos_extra = EXCLUDED.datos_extra,
       plataforma = 'vturb'`,
    [idCuenta, fecha, gasto, impresiones, clicks, cpm, cpc, ctr, play_rate, engagement, agendamientos,
     JSON.stringify({ player_id: player.id, player_name: player.name, raw_data: data })],
  );

  console.log(`[Vturb] cuenta=${idCuenta} player="${config.nombre_player}" fecha=${fecha} play_rate=${play_rate} impressions=${impresiones}`);
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function sincronizarAds(fechaOverride?: string): Promise<SincronizarAdsResult> {
  const fecha = fechaOverride ?? getYesterday();
  const errors: string[] = [];
  let processed = 0;

  // Load all accounts with active ads config
  const { rows } = await pgPool.query<CuentaAdsRow>(
    `SELECT id_cuenta, configuracion_ads FROM cuentas WHERE configuracion_ads IS NOT NULL AND configuracion_ads != '{}'::jsonb`,
  );

  for (const cuenta of rows) {
    const cfg = cuenta.configuracion_ads;
    if (!cfg) continue;

    // Meta
    if (cfg.meta?.activo && cfg.meta.ad_account_id && cfg.meta.access_token) {
      try {
        await sincronizarMetaAds(cuenta.id_cuenta, cfg.meta, fecha);
        processed++;
      } catch (e) {
        errors.push(`[Meta] cuenta ${cuenta.id_cuenta}: ${String(e)}`);
      }
    }

    // Google
    if (cfg.google?.activo && cfg.google.customer_id && cfg.google.developer_token) {
      try {
        await sincronizarGoogleAds(cuenta.id_cuenta, cfg.google, fecha);
        processed++;
      } catch (e) {
        errors.push(`[Google] cuenta ${cuenta.id_cuenta}: ${String(e)}`);
      }
    }

    // TikTok
    if (cfg.tiktok?.activo && cfg.tiktok.advertiser_id && cfg.tiktok.access_token) {
      try {
        await sincronizarTikTokAds(cuenta.id_cuenta, cfg.tiktok, fecha);
        processed++;
      } catch (e) {
        errors.push(`[TikTok] cuenta ${cuenta.id_cuenta}: ${String(e)}`);
      }
    }

    // Vturb
    if (cfg.vturb?.activo && cfg.vturb.api_token && cfg.vturb.nombre_player) {
      try {
        await sincronizarVturbAds(cuenta.id_cuenta, cfg.vturb, fecha);
        processed++;
      } catch (e) {
        errors.push(`[Vturb] cuenta ${cuenta.id_cuenta}: ${String(e)}`);
      }
    }
  }

  return {
    success: errors.length === 0,
    processed,
    errors,
  };
}

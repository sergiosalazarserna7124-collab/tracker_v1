import { db as pgPool } from "../../config/database.js";

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface AdsMetaConfig {
  activo: boolean;
  ad_account_id: string;
  access_token: string;
  cron_hora: number;
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

interface ConfiguracionAds {
  meta?: AdsMetaConfig;
  google?: AdsGoogleConfig;
  tiktok?: AdsTikTokConfig;
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
  url.searchParams.set("fields", "spend,impressions,clicks,campaign_name,adset_name,cpm,cpc,ctr");
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

  for (const row of rows) {
    const campana = String(row.campaign_name ?? "");
    const conjuntoAnuncios = String(row.adset_name ?? "");
    const gasto = parseFloat(String(row.spend ?? "0")) || 0;
    const impresiones = parseInt(String(row.impressions ?? "0"), 10) || 0;
    const clicks = parseInt(String(row.clicks ?? "0"), 10) || 0;
    const cpm = parseFloat(String(row.cpm ?? "0")) || 0;
    const cpc = parseFloat(String(row.cpc ?? "0")) || 0;
    const ctr = parseFloat(String(row.ctr ?? "0")) || 0;

    await pgPool.query(
      `INSERT INTO resumenes_diarios_ads
        (id_cuenta, fecha, plataforma, campana, conjunto_anuncios, gasto_total_ad, impresiones_totales, clicks_unicos, cpm, cpc, ctr)
       VALUES ($1, $2, 'meta', $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id_cuenta, fecha)
       DO UPDATE SET
         gasto_total_ad = EXCLUDED.gasto_total_ad,
         impresiones_totales = EXCLUDED.impresiones_totales,
         clicks_unicos = EXCLUDED.clicks_unicos,
         cpm = EXCLUDED.cpm,
         cpc = EXCLUDED.cpc,
         ctr = EXCLUDED.ctr,
         campana = EXCLUDED.campana,
         conjunto_anuncios = EXCLUDED.conjunto_anuncios,
         plataforma = 'meta'`,
      [idCuenta, fecha, campana, conjuntoAnuncios, gasto, impresiones, clicks, cpm, cpc, ctr],
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
  }

  return {
    success: errors.length === 0,
    processed,
    errors,
  };
}

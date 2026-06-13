// Set required env vars before any imports trigger env validation
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.CRON_SECRET = process.env.CRON_SECRET || "test-secret";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test";

import { test, describe, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// NOTE: the service is imported dynamically *after* the process.env assignments
// above. A static `import` is hoisted by the ESM loader above those assignments,
// which would trigger env validation (loadEnv) before the vars are set and crash
// the suite under a bare `npm test`. The top-level await keeps the env shim effective.
const { fetchAllMetaInsightPages } = await import("../services/cron/sincronizar-ads.service.js");

const SERVICE_SOURCE = readFileSync(
  resolve(import.meta.dirname, "../services/cron/sincronizar-ads.service.ts"),
  "utf8",
);

function makeFetchResponse(data: Record<string, unknown>[], paging?: { next?: string }): Response {
  const body = JSON.stringify({ data, paging });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("fetchAllMetaInsightPages — pagination", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("single page (no paging.next) returns all rows", async () => {
    const rows = [
      { campaign_name: "Camp A", spend: "10.50" },
      { campaign_name: "Camp B", spend: "20.00" },
    ];

    globalThis.fetch = mock.fn(async () => makeFetchResponse(rows)) as typeof fetch;

    const result = await fetchAllMetaInsightPages("https://example.com/insights");
    assert.equal(result.length, 2);
    assert.equal(result[0].campaign_name, "Camp A");
    assert.equal(result[1].campaign_name, "Camp B");
  });

  test("follows paging.next across multiple pages", async () => {
    const page1Rows = [{ campaign_name: "Camp A", spend: "10.00" }];
    const page2Rows = [{ campaign_name: "Camp B", spend: "20.00" }];
    const page3Rows = [{ campaign_name: "Camp C", spend: "30.00" }];

    let callCount = 0;
    globalThis.fetch = mock.fn(async (url: string | URL | Request) => {
      callCount++;
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("page=3")) {
        return makeFetchResponse(page3Rows);
      } else if (urlStr.includes("page=2")) {
        return makeFetchResponse(page2Rows, { next: "https://example.com/insights?page=3" });
      }
      return makeFetchResponse(page1Rows, { next: "https://example.com/insights?page=2" });
    }) as typeof fetch;

    const result = await fetchAllMetaInsightPages("https://example.com/insights?page=1");
    assert.equal(result.length, 3);
    assert.equal(result[0].campaign_name, "Camp A");
    assert.equal(result[1].campaign_name, "Camp B");
    assert.equal(result[2].campaign_name, "Camp C");
    assert.equal(callCount, 3);
  });

  test("handles empty data gracefully", async () => {
    globalThis.fetch = mock.fn(async () => makeFetchResponse([])) as typeof fetch;

    const result = await fetchAllMetaInsightPages("https://example.com/insights");
    assert.equal(result.length, 0);
  });

  test("throws on non-OK response", async () => {
    globalThis.fetch = mock.fn(async () =>
      new Response("Unauthorized", { status: 401 })
    ) as typeof fetch;

    await assert.rejects(
      () => fetchAllMetaInsightPages("https://example.com/insights"),
      (err: Error) => {
        assert.match(err.message, /Meta API error: 401/);
        return true;
      },
    );
  });

  test("stops at META_MAX_PAGES to prevent infinite loops", async () => {
    let callCount = 0;
    globalThis.fetch = mock.fn(async () => {
      callCount++;
      return makeFetchResponse(
        [{ campaign_name: `Camp-${callCount}`, spend: "1.00" }],
        { next: `https://example.com/insights?page=${callCount + 1}` },
      );
    }) as typeof fetch;

    const result = await fetchAllMetaInsightPages("https://example.com/insights");
    assert.equal(callCount, 50);
    assert.equal(result.length, 50);
  });
});

describe("sincronizarMetaAds — account-level row preservation (static checks)", () => {
  test("DELETE of account-level rows has been removed", () => {
    assert.ok(
      !SERVICE_SOURCE.includes("DELETE FROM resumenes_diarios_ads"),
      "DELETE of account-level rows should have been removed",
    );
  });

  test("fetches level=account insights as source of truth", () => {
    assert.ok(
      SERVICE_SOURCE.includes('"level", "account"'),
      "Should fetch level=account insights",
    );

    assert.ok(
      SERVICE_SOURCE.includes('source: "account_level"'),
      "Account-level row should have source marker in datos_extra",
    );
  });

  test("campaign-level fetch uses pagination", () => {
    assert.ok(
      SERVICE_SOURCE.includes("fetchAllMetaInsightPages"),
      "Campaign fetch should use fetchAllMetaInsightPages for pagination",
    );

    assert.ok(
      SERVICE_SOURCE.includes("META_PAGINATION_LIMIT"),
      "Should set a pagination limit on campaign requests",
    );
  });
});

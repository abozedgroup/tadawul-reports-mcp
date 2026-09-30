import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, openDb, readOnlyQuery } from "../dist/db.js";

function fresh() {
  const path = join(mkdtempSync(join(tmpdir(), "tadawul-")), "t.db");
  const store = new Store(openDb(path));
  store.upsertCompany({ symbol: "9999", name_ar: "شركة مثال", sector: "مثال" });
  store.upsertCompany({ symbol: "9998", name_ar: "شركة أخرى", sector: "مثال" });
  return { path, store };
}

test("stores a report and computes ratios", () => {
  const { store } = fresh();
  store.upsertReport({
    symbol: "9999", fiscal_year: 2025, period: "FY",
    metrics: { revenue: 1000, net_income: 200, total_equity: 2000, operating_cash_flow: 300, capex: -120 },
  });
  const r = store.getReport("9999", 2025, "FY");
  assert.equal(r.metrics.revenue, 1000);
  assert.equal(r.ratios.net_margin, 0.2);
  assert.equal(r.ratios.return_on_equity, 0.1);
  assert.equal(r.ratios.free_cash_flow, 180);
  assert.equal(r.ratios.gross_margin, null);
});

test("re-adding a report replaces its values", () => {
  const { store } = fresh();
  store.upsertReport({ symbol: "9999", fiscal_year: 2025, period: "Q1", metrics: { revenue: 1 } });
  store.upsertReport({ symbol: "9999", fiscal_year: 2025, period: "Q1", metrics: { revenue: 2 } });
  assert.equal(store.listReports({ symbol: "9999" }).length, 1);
  assert.equal(store.getReport("9999", 2025, "Q1").metrics.revenue, 2);
});

test("rejects a report for an unknown company", () => {
  const { store } = fresh();
  assert.throws(() => store.upsertReport({ symbol: "1234", fiscal_year: 2025, period: "FY", metrics: {} }));
});

test("rejects an unknown metric without leaving a partial report", () => {
  const { store } = fresh();
  assert.throws(() =>
    store.upsertReport({ symbol: "9999", fiscal_year: 2025, period: "FY", metrics: { revenue: 1, bogus: 2 } }),
  );
  assert.equal(store.listReports({ symbol: "9999" }).length, 0);
});

test("history, comparison and search", () => {
  const { store } = fresh();
  store.upsertReport({ symbol: "9999", fiscal_year: 2024, period: "FY", metrics: { net_income: 100 } });
  store.upsertReport({ symbol: "9999", fiscal_year: 2025, period: "FY", metrics: { net_income: 150 } });
  assert.deepEqual(store.metricHistory("9999", "net_income").map((r) => r.value), [100, 150]);
  const cmp = store.compare(["9999", "9998"], 2025, "FY", ["net_income"]);
  assert.equal(cmp[0].metrics.net_income, 150);
  assert.equal(cmp[1].found, false);
  assert.equal(store.searchCompanies("أخرى").length, 1);
});

test("query_sql only allows a single SELECT", () => {
  const { path } = fresh();
  assert.equal(readOnlyQuery(path, "SELECT symbol FROM companies ORDER BY symbol").length, 2);
  assert.throws(() => readOnlyQuery(path, "DELETE FROM companies"));
  assert.throws(() => readOnlyQuery(path, "SELECT 1; DELETE FROM companies"));
});

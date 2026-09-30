import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { METRIC_KEYS, PERIODS, Store } from "./db.js";

export const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));

const company = z.object({
  symbol: z.string().regex(/^\d{4}$/),
  name_ar: z.string(),
  name_en: z.string().optional(),
  sector: z.string().optional(),
  market: z.enum(["main", "nomu"]).optional(),
  isin: z.string().optional(),
});

const report = z.object({
  symbol: z.string().regex(/^\d{4}$/),
  fiscal_year: z.number().int(),
  period: z.enum(PERIODS),
  published_at: z.string().optional(),
  currency: z.string().optional(),
  unit: z.string().optional(),
  audited: z.boolean().optional(),
  source_url: z.string().optional(),
  notes: z.string().optional(),
  metrics: z.partialRecord(z.enum(METRIC_KEYS), z.number()),
});

const importFile = z.object({
  companies: z.array(company).default([]),
  reports: z.array(report).default([]),
});

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function seedCompanies(store: Store, path = join(DATA_DIR, "companies.json")): number {
  const companies = z.array(company).parse(readJson(path));
  for (const c of companies) store.upsertCompany(c);
  return companies.length;
}

export function importFromFile(store: Store, path: string) {
  const data = importFile.parse(readJson(path));
  for (const c of data.companies) store.upsertCompany(c);
  for (const r of data.reports) store.upsertReport(r);
  return { companies: data.companies.length, reports: data.reports.length };
}

/** Loads the company list and every report file shipped in data/reports/. */
export function loadBundledData(store: Store) {
  const companies = seedCompanies(store);
  let reports = 0;
  const dir = join(DATA_DIR, "reports");
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    reports += importFromFile(store, join(dir, name)).reports;
  }
  return { companies, reports };
}

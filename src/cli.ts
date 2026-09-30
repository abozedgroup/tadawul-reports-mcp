#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { METRIC_KEYS, PERIODS, Store, openDb } from "./db.js";

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

const [command, file] = process.argv.slice(2);
const store = new Store(openDb());

if (command === "seed") {
  const path = file ?? fileURLToPath(new URL("../data/companies.json", import.meta.url));
  const companies = z.array(company).parse(readJson(path));
  for (const c of companies) store.upsertCompany(c);
  console.log(`أُضيفت أو حُدّثت ${companies.length} شركة.`);
} else if (command === "import" && file) {
  const data = importFile.parse(readJson(file));
  for (const c of data.companies) store.upsertCompany(c);
  for (const r of data.reports) store.upsertReport(r);
  console.log(`استُورد ${data.companies.length} شركة و${data.reports.length} تقرير.`);
} else {
  console.error("الاستخدام:\n  tadawul-cli seed [companies.json]\n  tadawul-cli import <file.json>");
  process.exit(1);
}

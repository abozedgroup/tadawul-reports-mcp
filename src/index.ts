#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { METRICS, METRIC_KEYS, PERIODS, Store, defaultDbPath, openDb, readOnlyQuery } from "./db.js";

const dbPath = defaultDbPath();
const store = new Store(openDb(dbPath));

const server = new McpServer({ name: "tadawul-reports", version: "0.1.0" });

const symbol = z.string().regex(/^\d{4}$/).describe("رمز الشركة في تداول، أربعة أرقام مثل 2222");
const fiscalYear = z.number().int().min(1990).max(2100).describe("السنة المالية");
const period = z.enum(PERIODS).describe("الفترة: Q1..Q4 للربع، H1 نصف سنوي، 9M تسعة أشهر، FY سنوي");
const metric = z.enum(METRIC_KEYS);

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

server.registerTool(
  "search_companies",
  {
    title: "البحث عن شركة",
    description: "ابحث عن الشركات المدرجة بالرمز أو الاسم العربي أو الإنجليزي، أو صفّها حسب القطاع.",
    inputSchema: { query: z.string().optional(), sector: z.string().optional() },
  },
  async ({ query, sector }) => json(store.searchCompanies(query, sector)),
);

server.registerTool(
  "list_sectors",
  { title: "القطاعات", description: "اعرض القطاعات وعدد الشركات في كل قطاع.", inputSchema: {} },
  async () => json(store.listSectors()),
);

server.registerTool(
  "list_metrics",
  { title: "البنود المالية", description: "اعرض مفاتيح البنود المالية المدعومة وأسماءها العربية.", inputSchema: {} },
  async () => json(METRICS),
);

server.registerTool(
  "upsert_company",
  {
    title: "إضافة أو تحديث شركة",
    description: "أضف شركة مدرجة أو حدّث بياناتها.",
    inputSchema: {
      symbol,
      name_ar: z.string(),
      name_en: z.string().optional(),
      sector: z.string().optional(),
      market: z.enum(["main", "nomu"]).default("main").describe("main للسوق الرئيسية، nomu للسوق الموازية"),
      isin: z.string().optional(),
    },
  },
  async (c) => {
    store.upsertCompany(c);
    return json(store.getCompany(c.symbol));
  },
);

server.registerTool(
  "list_reports",
  {
    title: "قائمة التقارير",
    description: "اعرض التقارير المخزّنة، مع تصفية اختيارية حسب الشركة والسنة والفترة.",
    inputSchema: { symbol: symbol.optional(), fiscal_year: fiscalYear.optional(), period: period.optional() },
  },
  async (f) => json(store.listReports(f)),
);

server.registerTool(
  "get_report",
  {
    title: "تفاصيل تقرير",
    description: "اعرض بنود تقرير مالي لشركة في سنة وفترة محددة، مع النسب المحسوبة (الهوامش، العائد على حقوق المساهمين، إلخ).",
    inputSchema: { symbol, fiscal_year: fiscalYear, period },
  },
  async ({ symbol, fiscal_year, period }) => {
    const r = store.getReport(symbol, fiscal_year, period);
    return r ? json(r) : fail(`لا يوجد تقرير ${period} ${fiscal_year} للشركة ${symbol}.`);
  },
);

server.registerTool(
  "add_report",
  {
    title: "إضافة تقرير",
    description:
      "أضف تقريراً مالياً أو استبدل الموجود لنفس الشركة والسنة والفترة. أدخل الأرقام كما وردت في القوائم المالية المنشورة ووضّح الوحدة.",
    inputSchema: {
      symbol,
      fiscal_year: fiscalYear,
      period,
      published_at: z.string().date().optional().describe("تاريخ النشر YYYY-MM-DD"),
      currency: z.string().default("SAR"),
      unit: z.enum(["units", "thousand", "million", "billion"]).default("million"),
      audited: z.boolean().default(false),
      source_url: z.string().url().optional().describe("رابط التقرير في موقع تداول أو موقع الشركة"),
      notes: z.string().optional(),
      metrics: z.partialRecord(metric, z.number()).describe("البنود المالية؛ استخدم list_metrics لمعرفة المفاتيح"),
    },
  },
  async (r) => {
    try {
      store.upsertReport(r);
      return json(store.getReport(r.symbol, r.fiscal_year, r.period));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "delete_report",
  {
    title: "حذف تقرير",
    description: "احذف تقريراً وبنوده.",
    inputSchema: { symbol, fiscal_year: fiscalYear, period },
  },
  async ({ symbol, fiscal_year, period }) =>
    store.deleteReport(symbol, fiscal_year, period) ? json({ deleted: true }) : fail("التقرير غير موجود."),
);

server.registerTool(
  "compare_companies",
  {
    title: "مقارنة شركات",
    description: "قارن بين عدة شركات في نفس السنة والفترة.",
    inputSchema: {
      symbols: z.array(symbol).min(2).max(20),
      fiscal_year: fiscalYear,
      period,
      metrics: z.array(metric).optional(),
    },
  },
  async ({ symbols, fiscal_year, period, metrics }) => json(store.compare(symbols, fiscal_year, period, metrics)),
);

server.registerTool(
  "metric_history",
  {
    title: "تاريخ بند مالي",
    description: "اعرض تطور بند مالي لشركة عبر السنوات، مثل نمو صافي الربح السنوي.",
    inputSchema: { symbol, metric, period: period.optional() },
  },
  async ({ symbol, metric, period }) => json(store.metricHistory(symbol, metric, period)),
);

server.registerTool(
  "query_sql",
  {
    title: "استعلام SQL",
    description:
      "نفّذ استعلام SELECT للقراءة فقط على قاعدة البيانات. الجداول: companies(symbol, name_ar, name_en, sector, market, isin)، " +
      "reports(id, symbol, fiscal_year, period, published_at, currency, unit, audited, source_url, notes)، " +
      "report_items(report_id, metric, value).",
    inputSchema: { sql: z.string(), limit: z.number().int().min(1).max(5000).default(500) },
  },
  async ({ sql, limit }) => {
    try {
      return json(readOnlyQuery(dbPath, sql, limit));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

await server.connect(new StdioServerTransport());

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const PERIODS = ["Q1", "Q2", "Q3", "Q4", "H1", "9M", "FY"] as const;
export type Period = (typeof PERIODS)[number];

// Standard line items. Values are stored in the report's currency and unit
// (EPS and DPS per share; everything else in the report's `unit`).
export const METRICS = {
  revenue: "الإيرادات",
  gross_profit: "إجمالي الربح",
  operating_profit: "الربح التشغيلي",
  net_income: "صافي الربح العائد للمساهمين",
  eps: "ربحية السهم",
  total_assets: "إجمالي الموجودات",
  total_liabilities: "إجمالي المطلوبات",
  total_equity: "إجمالي حقوق المساهمين",
  operating_cash_flow: "صافي النقد من الأنشطة التشغيلية",
  capex: "النفقات الرأسمالية",
  dividends_per_share: "توزيعات الأرباح للسهم",
} as const;
export type MetricKey = keyof typeof METRICS;
export const METRIC_KEYS = Object.keys(METRICS) as [MetricKey, ...MetricKey[]];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  symbol      TEXT PRIMARY KEY,
  name_ar     TEXT NOT NULL,
  name_en     TEXT,
  sector      TEXT,
  market      TEXT NOT NULL DEFAULT 'main' CHECK (market IN ('main', 'nomu')),
  isin        TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL REFERENCES companies(symbol) ON DELETE CASCADE,
  fiscal_year   INTEGER NOT NULL,
  period        TEXT NOT NULL CHECK (period IN ('Q1','Q2','Q3','Q4','H1','9M','FY')),
  published_at  TEXT,
  currency      TEXT NOT NULL DEFAULT 'SAR',
  unit          TEXT NOT NULL DEFAULT 'million',
  audited       INTEGER NOT NULL DEFAULT 0,
  source_url    TEXT,
  notes         TEXT,
  UNIQUE (symbol, fiscal_year, period)
);

CREATE TABLE IF NOT EXISTS report_items (
  report_id  INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  metric     TEXT NOT NULL,
  value      REAL NOT NULL,
  PRIMARY KEY (report_id, metric)
);

CREATE INDEX IF NOT EXISTS reports_by_year ON reports (fiscal_year, period);
`;

export function defaultDbPath(): string {
  return resolve(process.env.TADAWUL_DB_PATH ?? "data/tadawul.db");
}

export function openDb(path = defaultDbPath()): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

export interface Company {
  symbol: string;
  name_ar: string;
  name_en?: string | null;
  sector?: string | null;
  market?: "main" | "nomu";
  isin?: string | null;
}

export interface ReportInput {
  symbol: string;
  fiscal_year: number;
  period: Period;
  published_at?: string | null;
  currency?: string;
  unit?: string;
  audited?: boolean;
  source_url?: string | null;
  notes?: string | null;
  metrics: Partial<Record<MetricKey, number>>;
}

interface ReportRow {
  id: number;
  symbol: string;
  name_ar: string;
  name_en: string | null;
  sector: string | null;
  fiscal_year: number;
  period: Period;
  published_at: string | null;
  currency: string;
  unit: string;
  audited: number;
  source_url: string | null;
  notes: string | null;
}

export class Store {
  constructor(readonly db: DatabaseSync) {}

  upsertCompany(c: Company): void {
    this.db
      .prepare(
        `INSERT INTO companies (symbol, name_ar, name_en, sector, market, isin)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (symbol) DO UPDATE SET
           name_ar = excluded.name_ar,
           name_en = COALESCE(excluded.name_en, name_en),
           sector  = COALESCE(excluded.sector, sector),
           market  = excluded.market,
           isin    = COALESCE(excluded.isin, isin)`,
      )
      .run(c.symbol, c.name_ar, c.name_en ?? null, c.sector ?? null, c.market ?? "main", c.isin ?? null);
  }

  getCompany(symbol: string) {
    return this.db.prepare("SELECT * FROM companies WHERE symbol = ?").get(symbol) as Company | undefined;
  }

  searchCompanies(query?: string, sector?: string) {
    const q = query ? `%${query}%` : null;
    const s = sector ? `%${sector}%` : null;
    return this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM reports r WHERE r.symbol = c.symbol) AS report_count
         FROM companies c
         WHERE (? IS NULL OR c.symbol LIKE ? OR c.name_ar LIKE ? OR c.name_en LIKE ?)
           AND (? IS NULL OR c.sector LIKE ?)
         ORDER BY c.symbol`,
      )
      .all(q, q, q, q, s, s);
  }

  listSectors() {
    return this.db
      .prepare("SELECT sector, COUNT(*) AS companies FROM companies GROUP BY sector ORDER BY sector")
      .all();
  }

  /** Inserts a report or replaces the one for the same company, year and period. */
  upsertReport(r: ReportInput): number {
    if (!this.getCompany(r.symbol)) throw new Error(`الشركة ${r.symbol} غير موجودة. أضفها أولاً.`);
    this.db.exec("BEGIN");
    try {
      const row = this.db
        .prepare(
          `INSERT INTO reports (symbol, fiscal_year, period, published_at, currency, unit, audited, source_url, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (symbol, fiscal_year, period) DO UPDATE SET
             published_at = excluded.published_at,
             currency = excluded.currency,
             unit = excluded.unit,
             audited = excluded.audited,
             source_url = excluded.source_url,
             notes = excluded.notes
           RETURNING id`,
        )
        .get(
          r.symbol,
          r.fiscal_year,
          r.period,
          r.published_at ?? null,
          r.currency ?? "SAR",
          r.unit ?? "million",
          r.audited ? 1 : 0,
          r.source_url ?? null,
          r.notes ?? null,
        ) as { id: number };
      const put = this.db.prepare(
        `INSERT INTO report_items (report_id, metric, value) VALUES (?, ?, ?)
         ON CONFLICT (report_id, metric) DO UPDATE SET value = excluded.value`,
      );
      for (const [metric, value] of Object.entries(r.metrics)) {
        if (!(metric in METRICS)) throw new Error(`بند غير معروف: ${metric}`);
        if (value !== undefined && value !== null) put.run(row.id, metric, value);
      }
      this.db.exec("COMMIT");
      return row.id;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  deleteReport(symbol: string, fiscal_year: number, period: Period): boolean {
    const res = this.db
      .prepare("DELETE FROM reports WHERE symbol = ? AND fiscal_year = ? AND period = ?")
      .run(symbol, fiscal_year, period);
    return res.changes > 0;
  }

  listReports(filter: { symbol?: string; fiscal_year?: number; period?: Period }) {
    return this.db
      .prepare(
        `SELECT r.id, r.symbol, c.name_ar, r.fiscal_year, r.period, r.published_at, r.audited, r.source_url
         FROM reports r JOIN companies c USING (symbol)
         WHERE (? IS NULL OR r.symbol = ?)
           AND (? IS NULL OR r.fiscal_year = ?)
           AND (? IS NULL OR r.period = ?)
         ORDER BY r.fiscal_year DESC, r.period DESC, r.symbol`,
      )
      .all(
        filter.symbol ?? null, filter.symbol ?? null,
        filter.fiscal_year ?? null, filter.fiscal_year ?? null,
        filter.period ?? null, filter.period ?? null,
      );
  }

  getReport(symbol: string, fiscal_year: number, period: Period) {
    const report = this.db
      .prepare(
        `SELECT r.*, c.name_ar, c.name_en, c.sector
         FROM reports r JOIN companies c USING (symbol)
         WHERE r.symbol = ? AND r.fiscal_year = ? AND r.period = ?`,
      )
      .get(symbol, fiscal_year, period) as ReportRow | undefined;
    if (!report) return undefined;
    const metrics = this.metricsOf(report.id);
    return { ...report, audited: report.audited === 1, metrics, ratios: ratios(metrics) };
  }

  compare(symbols: string[], fiscal_year: number, period: Period, metrics?: MetricKey[]) {
    return symbols.map((symbol) => {
      const r = this.getReport(symbol, fiscal_year, period);
      if (!r) return { symbol, found: false };
      const m = metrics
        ? Object.fromEntries(metrics.map((k) => [k, r.metrics[k] ?? null]))
        : r.metrics;
      return { symbol, name_ar: r.name_ar, found: true, unit: r.unit, currency: r.currency, metrics: m, ratios: r.ratios };
    });
  }

  metricHistory(symbol: string, metric: MetricKey, period?: Period) {
    return this.db
      .prepare(
        `SELECT r.fiscal_year, r.period, i.value, r.unit, r.currency
         FROM reports r JOIN report_items i ON i.report_id = r.id
         WHERE r.symbol = ? AND i.metric = ? AND (? IS NULL OR r.period = ?)
         ORDER BY r.fiscal_year, r.period`,
      )
      .all(symbol, metric, period ?? null, period ?? null);
  }

  private metricsOf(reportId: number): Partial<Record<MetricKey, number>> {
    const rows = this.db
      .prepare("SELECT metric, value FROM report_items WHERE report_id = ?")
      .all(reportId) as { metric: MetricKey; value: number }[];
    return Object.fromEntries(rows.map((r) => [r.metric, r.value]));
  }
}

function ratio(a?: number, b?: number): number | null {
  if (a === undefined || b === undefined || b === 0) return null;
  return Math.round((a / b) * 10000) / 10000;
}

export function ratios(m: Partial<Record<MetricKey, number>>) {
  return {
    gross_margin: ratio(m.gross_profit, m.revenue),
    operating_margin: ratio(m.operating_profit, m.revenue),
    net_margin: ratio(m.net_income, m.revenue),
    return_on_equity: ratio(m.net_income, m.total_equity),
    return_on_assets: ratio(m.net_income, m.total_assets),
    debt_to_equity: ratio(m.total_liabilities, m.total_equity),
    free_cash_flow:
      m.operating_cash_flow !== undefined && m.capex !== undefined ? m.operating_cash_flow - Math.abs(m.capex) : null,
  };
}

/** Runs a single read-only SELECT against a separate read-only connection. */
export function readOnlyQuery(path: string, sql: string, limit = 500) {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed) || trimmed.includes(";")) {
    throw new Error("يُسمح فقط باستعلام SELECT واحد.");
  }
  const ro = new DatabaseSync(path, { readOnly: true });
  try {
    return ro.prepare(`SELECT * FROM (${trimmed}) LIMIT ${limit}`).all();
  } finally {
    ro.close();
  }
}

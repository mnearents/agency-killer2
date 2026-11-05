/**
 * Goals: what the business is aiming at, and how far along it is.
 *
 * Targets are set per period (a year or a month) and per business line, and
 * quarterly priorities as a ranked list. Stored append-only in `goals`: the
 * newest row for a period and line is current, and the table is its history.
 *
 * Pace is measured only where a plan exists. A line with no target has no
 * gap — reporting it as beating a target of zero would be a number nobody
 * set. Wholesale cannot be measured at all yet: nothing in the order data
 * tells a wholesale order apart, so its actual is unknown, not zero.
 */

import { sql, desc, and, eq, like } from "drizzle-orm";
import type { Db } from "@/db/client";
import { goals } from "@/db/schema";

export const GOAL_LINES = ["total", "subscription", "physical", "digital", "wholesale"] as const;
export type GoalLine = (typeof GOAL_LINES)[number];
/** The lines the order data can classify. Their sum is the measured total. */
export const MEASURED_LINES = ["subscription", "physical", "digital"] as const;
type MeasuredLine = (typeof MEASURED_LINES)[number];

export interface GoalTarget {
  /** "2027" or "2027-03". */
  period: string;
  line: GoalLine;
  targetCents: number | null;
}

export type PeriodKind = "year" | "month" | "quarter";

export function parsePeriod(input: string): { kind: PeriodKind; period: string } {
  const p = input.trim().toUpperCase();
  if (/^\d{4}$/.test(p)) return { kind: "year", period: p };
  const m = /^(\d{4})-(\d{2})$/.exec(p);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { kind: "month", period: p };
  if (/^\d{4}-Q[1-4]$/.test(p)) return { kind: "quarter", period: p };
  throw new Error(`Period must be YYYY, YYYY-MM or YYYY-Qn; got "${input}"`);
}

export function quarterOf(d: Date): string {
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

export function parsePriorities(text: string): string[] {
  const list = text
    .split("\n")
    .map((l) => l.trim().replace(/^(\d+[.)]|[-*•])\s*/, "").trim())
    .filter(Boolean);
  if (list.length === 0) throw new Error("Priorities need at least one line, most important first.");
  return list;
}

const dollars = (cents: number | null) => (cents === null ? null : Math.round(cents) / 100);
const round2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

export interface LinePace {
  line: GoalLine;
  /** Where the targets came from. */
  basis: "monthly targets" | "straight-line from the annual target" | "sum of line targets" | "no plan";
  monthToDate: { actualDollars: number | null; targetDollars: number | null; targetToDateDollars: number | null; gapToDateDollars: number | null };
  yearToDate: {
    actualDollars: number | null;
    targetToDateDollars: number | null;
    gapToDateDollars: number | null;
    annualTargetDollars: number | null;
    projectedYearDollars: number | null;
  };
  note?: string;
}

export interface PaceActuals {
  monthToDate: Record<MeasuredLine, number>;
  yearToDate: Record<MeasuredLine, number>;
}

/**
 * Actual against plan for each line, month to date and year to date, as of a
 * day. The month's target is due pro rata — half the month gone, half the
 * target due — and the year's is the full months before plus that share.
 */
export function computePace(targets: GoalTarget[], actuals: PaceActuals, asOf: Date) {
  const year = asOf.getUTCFullYear();
  const month = asOf.getUTCMonth() + 1;
  const day = asOf.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const yearStart = Date.UTC(year, 0, 1);
  const dayOfYear = Math.floor((Date.UTC(year, month - 1, day) - yearStart) / 86_400_000) + 1;
  const daysInYear = (Date.UTC(year + 1, 0, 1) - yearStart) / 86_400_000;
  const monthKey = (m: number) => `${year}-${String(m).padStart(2, "0")}`;

  const target = (period: string, line: GoalLine) =>
    targets.find((t) => t.period === period && t.line === line)?.targetCents ?? null;

  /** Monthly targets for a line, 1-12, or null where none was set. */
  const monthly = (line: GoalLine) => Array.from({ length: 12 }, (_, i) => target(monthKey(i + 1), line));

  function plan(line: GoalLine): { months: (number | null)[]; basis: LinePace["basis"] } {
    const own = monthly(line);
    if (own.some((v) => v !== null)) return { months: own, basis: "monthly targets" };
    if (line === "total") {
      const parts = MEASURED_LINES.map((l) => monthly(l));
      if (parts.every((p) => p.every((v) => v !== null))) {
        return { months: own.map((_, i) => parts.reduce((s, p) => s + (p[i] as number), 0)), basis: "sum of line targets" };
      }
    }
    const annual = target(String(year), line);
    if (annual !== null) {
      // Straight line by days, so February is not given a twelfth of the year.
      return {
        months: own.map((_, i) => (annual * new Date(Date.UTC(year, i + 1, 0)).getUTCDate()) / daysInYear),
        basis: "straight-line from the annual target",
      };
    }
    return { months: own, basis: "no plan" };
  }

  const actualFor = (line: GoalLine, scope: keyof PaceActuals): number | null => {
    if (line === "wholesale") return null;
    if (line === "total") return MEASURED_LINES.reduce((s, l) => s + actuals[scope][l], 0);
    return actuals[scope][line as MeasuredLine];
  };

  const lines: LinePace[] = GOAL_LINES.map((line) => {
    const { months, basis } = plan(line);
    const monthTarget = months[month - 1];
    const monthDue = monthTarget === null ? null : (monthTarget * day) / daysInMonth;
    const priorMonths = months.slice(0, month - 1);
    const yearDue = monthDue === null || priorMonths.some((v) => v === null)
      ? null
      : priorMonths.reduce((s: number, v) => s + (v as number), 0) + monthDue;
    const annual = target(String(year), line) ?? (months.every((v) => v !== null) ? months.reduce((s: number, v) => s + (v as number), 0) : null);

    const mtd = actualFor(line, "monthToDate");
    const ytd = actualFor(line, "yearToDate");
    const pace: LinePace = {
      line,
      basis,
      monthToDate: {
        actualDollars: dollars(mtd),
        targetDollars: dollars(monthTarget),
        targetToDateDollars: round2(dollars(monthDue)),
        gapToDateDollars: mtd === null || monthDue === null ? null : round2(dollars(mtd - monthDue)),
      },
      yearToDate: {
        actualDollars: dollars(ytd),
        targetToDateDollars: round2(dollars(yearDue)),
        gapToDateDollars: ytd === null || yearDue === null ? null : round2(dollars(ytd - yearDue)),
        annualTargetDollars: dollars(annual),
        projectedYearDollars: ytd === null ? null : round2(dollars((ytd / dayOfYear) * daysInYear)),
      },
    };
    if (line === "wholesale") {
      pace.note = "Wholesale orders cannot be told apart in the Shopify data, so wholesale revenue is unmeasured (and sits inside the other lines). Its target is shown without an actual.";
    } else if (basis === "no plan") {
      pace.note = `No monthly targets or annual target set for ${line} in ${year}, so there is nothing to be ahead or behind of. Set them with goals_set.`;
    } else if (monthTarget === null) {
      pace.note = `No monthly targets for ${line} cover this month. Set them with goals_set.`;
    }
    return pace;
  });

  return { asOf: asOf.toISOString().slice(0, 10), year, dayOfYear, daysInYear, dayOfMonth: day, daysInMonth, lines };
}

// ─── Storage ───────────────────────────────────────────────────────────

export interface GoalRow {
  kind: "target" | "priorities";
  period: string;
  line: string | null;
  targetCents: number | null;
  priorities: string[] | null;
  notes: string | null;
  author: string;
  requestedBy: string | null;
  setAt: Date;
}

/** The newest row per (kind, period, line) whose period starts with `prefix`. */
export async function getCurrentGoals(db: Db, prefix: string): Promise<GoalRow[]> {
  const rows = (await db.execute(sql`
    select distinct on (kind, period, coalesce(line, ''))
      kind, period, line, target_cents as "targetCents", priorities, notes, author,
      requested_by as "requestedBy", created_at as "setAt"
    from goals
    where period like ${prefix + "%"}
    order by kind, period, coalesce(line, ''), created_at desc, id desc`)) as unknown as GoalRow[];
  return rows.map((r) => ({ ...r, targetCents: r.targetCents === null ? null : Number(r.targetCents), setAt: new Date(r.setAt) }));
}

export async function getGoalHistory(db: Db, prefix: string) {
  return db.select().from(goals).where(like(goals.period, `${prefix}%`)).orderBy(desc(goals.createdAt), desc(goals.id)).limit(200);
}

export async function recordGoal(db: Db, row: Omit<GoalRow, "setAt">) {
  const [saved] = await db.insert(goals).values(row).returning();
  return saved;
}

export async function getCurrentGoal(db: Db, kind: GoalRow["kind"], period: string, line: string | null) {
  const [row] = await db
    .select()
    .from(goals)
    .where(and(eq(goals.kind, kind), eq(goals.period, period), line === null ? sql`${goals.line} is null` : eq(goals.line, line)))
    .orderBy(desc(goals.createdAt), desc(goals.id))
    .limit(1);
  return row ?? null;
}

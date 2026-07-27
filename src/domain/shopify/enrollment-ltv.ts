/**
 * Enrollment-based LTV computation — uses customer metafield data
 * from automatik.enrollments for accurate tenure and LTV.
 *
 * Each enrollment is one month of subscription. Deduped by month
 * string (YYYY-MM) — duplicates within the same month are ignored.
 *
 * Tier pricing:
 *   Color Happy era: t1 = $5/mo
 *   RAD era: t1 = $8/mo, t2 = $15/mo
 *   Transition happened around mid-2025.
 */

export interface RawEnrollment {
  tier: string; // "t1" or "t2"
  month: string; // "YYYY-MM"
  month_id: number;
}

export interface CustomerEnrollmentData {
  customerId: string;
  enrollments: string; // raw JSON string
}

export interface DeduplicatedEnrollment {
  month: string; // "YYYY-MM"
  tier: "t1" | "t2";
}

export interface CustomerEnrollmentLtv {
  customerId: string;
  totalMonths: number;
  t1Months: number;
  t2Months: number;
  firstMonth: string;
  lastMonth: string;
  currentTier: "t1" | "t2";
  isActive: boolean;
  estimatedLtvCents: number;
  estimatedMonthlyValueCents: number;
}

export interface EnrollmentLtvSummary {
  totalSubscribers: number;
  activeSubscribers: number;
  churnedSubscribers: number;
  avgTenureMonths: number;
  medianTenureMonths: number;
  avgLtvCents: number;
  avgMonthlyValueCents: number;
  t1Summary: { subscribers: number; active: number; avgTenure: number; avgLtv: number };
  t2Summary: { subscribers: number; active: number; avgTenure: number; avgLtv: number };
}

// RAD launched approximately mid-2025. Before that, t1 = $5/mo.
const RAD_CUTOVER_MONTH = "2025-06";

/**
 * Get the monthly price in cents for a given tier and month.
 */
export function getMonthlyPriceCents(tier: "t1" | "t2", month: string): number {
  if (month < RAD_CUTOVER_MONTH) {
    // Color Happy era: only had t1 at $5/mo
    return 500;
  }
  // RAD era
  return tier === "t2" ? 1500 : 800;
}

/**
 * Parse and deduplicate enrollments from the raw JSON metafield.
 * Dedupes by month — keeps the higher tier if a month has both.
 */
export function parseEnrollments(json: string): DeduplicatedEnrollment[] {
  let raw: RawEnrollment[];
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }

  if (!Array.isArray(raw)) return [];

  // Dedupe by month, keeping higher tier
  const byMonth = new Map<string, "t1" | "t2">();
  for (const entry of raw) {
    if (!entry.month || !entry.tier) continue;
    const tier = entry.tier === "t2" ? "t2" : "t1";
    const existing = byMonth.get(entry.month);
    if (!existing || tier === "t2") {
      byMonth.set(entry.month, tier);
    }
  }

  // Sort by month
  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, tier]) => ({ month, tier }));
}

/**
 * Compute LTV for a single customer from their enrollment data.
 */
export function computeEnrollmentLtv(
  customerId: string,
  enrollmentsJson: string,
  asOfMonth?: string // "YYYY-MM", defaults to current month
): CustomerEnrollmentLtv | null {
  const enrollments = parseEnrollments(enrollmentsJson);
  if (enrollments.length === 0) return null;

  const now = asOfMonth ?? new Date().toISOString().slice(0, 7);

  // Filter to enrollments up to current month (ignore future pre-enrollments)
  const current = enrollments.filter((e) => e.month <= now);
  if (current.length === 0) return null;

  const t1Months = current.filter((e) => e.tier === "t1").length;
  const t2Months = current.filter((e) => e.tier === "t2").length;

  const firstMonth = current[0].month;
  const lastMonth = current[current.length - 1].month;
  const currentTier = current[current.length - 1].tier;

  // Compute estimated LTV using historical pricing
  const estimatedLtvCents = current.reduce(
    (sum, e) => sum + getMonthlyPriceCents(e.tier, e.month),
    0
  );

  // Active = has enrollment in the current month or last month
  const recentMonths = [now];
  // Also check previous month (billing might lag)
  const [y, m] = now.split("-").map(Number);
  const prevMonth = m === 1
    ? `${y - 1}-12`
    : `${y}-${String(m - 1).padStart(2, "0")}`;
  recentMonths.push(prevMonth);

  const isActive = current.some((e) => recentMonths.includes(e.month));

  return {
    customerId,
    totalMonths: current.length,
    t1Months,
    t2Months,
    firstMonth,
    lastMonth,
    currentTier,
    isActive,
    estimatedLtvCents,
    estimatedMonthlyValueCents: Math.round(estimatedLtvCents / current.length),
  };
}

/**
 * Compute aggregate LTV summary across all subscribers.
 */
export function computeEnrollmentLtvSummary(
  customers: CustomerEnrollmentData[],
  asOfMonth?: string
): EnrollmentLtvSummary {
  const ltvs: CustomerEnrollmentLtv[] = [];
  for (const customer of customers) {
    const ltv = computeEnrollmentLtv(customer.customerId, customer.enrollments, asOfMonth);
    if (ltv) ltvs.push(ltv);
  }

  if (ltvs.length === 0) {
    return {
      totalSubscribers: 0,
      activeSubscribers: 0,
      churnedSubscribers: 0,
      avgTenureMonths: 0,
      medianTenureMonths: 0,
      avgLtvCents: 0,
      avgMonthlyValueCents: 0,
      t1Summary: { subscribers: 0, active: 0, avgTenure: 0, avgLtv: 0 },
      t2Summary: { subscribers: 0, active: 0, avgTenure: 0, avgLtv: 0 },
    };
  }

  const active = ltvs.filter((l) => l.isActive);
  const churned = ltvs.filter((l) => !l.isActive);

  const totalTenure = ltvs.reduce((s, l) => s + l.totalMonths, 0);
  const totalLtv = ltvs.reduce((s, l) => s + l.estimatedLtvCents, 0);
  const totalMonthly = ltvs.reduce((s, l) => s + l.estimatedMonthlyValueCents, 0);

  const sortedTenures = ltvs.map((l) => l.totalMonths).sort((a, b) => a - b);
  const mid = Math.floor(sortedTenures.length / 2);
  const medianTenure =
    sortedTenures.length % 2 === 0
      ? (sortedTenures[mid - 1] + sortedTenures[mid]) / 2
      : sortedTenures[mid];

  // Per-tier breakdown (by current tier)
  const t1 = ltvs.filter((l) => l.currentTier === "t1");
  const t2 = ltvs.filter((l) => l.currentTier === "t2");

  function tierSummary(tierLtvs: CustomerEnrollmentLtv[]) {
    if (tierLtvs.length === 0) return { subscribers: 0, active: 0, avgTenure: 0, avgLtv: 0 };
    return {
      subscribers: tierLtvs.length,
      active: tierLtvs.filter((l) => l.isActive).length,
      avgTenure: tierLtvs.reduce((s, l) => s + l.totalMonths, 0) / tierLtvs.length,
      avgLtv: tierLtvs.reduce((s, l) => s + l.estimatedLtvCents, 0) / tierLtvs.length,
    };
  }

  return {
    totalSubscribers: ltvs.length,
    activeSubscribers: active.length,
    churnedSubscribers: churned.length,
    avgTenureMonths: totalTenure / ltvs.length,
    medianTenureMonths: medianTenure,
    avgLtvCents: totalLtv / ltvs.length,
    avgMonthlyValueCents: totalMonthly / ltvs.length,
    t1Summary: tierSummary(t1),
    t2Summary: tierSummary(t2),
  };
}

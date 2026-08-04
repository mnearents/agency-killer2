/**
 * Weekly report data gathering — pure functions that format channel
 * data into prompt blocks for the AI analysis step.
 *
 * No DB calls here — this module receives pre-fetched data and
 * transforms it into the text that goes into the Claude prompt.
 */

export interface WeekRange {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD
  label: string; // "Jul 28 – Aug 3"
}

// ─── Ads ──────────────────────────────────────────────────────────────

export interface CreativeSummary {
  name: string;
  roas: number | null;
  spendDollars: number;
  revenueDollars: number;
}

export interface AdsWeekData {
  totalSpendDollars: number;
  totalRevenueDollars: number;
  roas: number | null;
  totalImpressions: number;
  totalClicks: number;
  ctr: number | null;
  totalPurchases: number;
  costPerPurchaseDollars: number | null;
  topCreatives: CreativeSummary[];
}

// ─── Shopify ──────────────────────────────────────────────────────────

export interface ProductCount {
  title: string;
  count: number;
}

export interface ShopifyWeekData {
  totalOrders: number;
  totalRevenueDollars: number;
  subscriptionOrders: number;
  subscriptionRevenueDollars: number;
  avgOrderValueDollars: number;
  topProducts: ProductCount[];
}

// ─── Social ───────────────────────────────────────────────────────────

export interface TopPostSummary {
  caption: string | null;
  engagementRate: number | null;
  saves: number;
  format: string;
  permalink: string | null;
}

export interface SocialWeekData {
  postsPublished: number;
  totalReach: number;
  avgEngagementRate: number | null;
  totalSaves: number;
  totalShares: number;
  topPost: TopPostSummary | null;
  reelPlays: number;
}

// ─── Email/SMS (Attentive) ────────────────────────────────────────────

export interface EmailSmsWeekData {
  emailDelivered: number;
  emailClicks: number;
  emailConversions: number;
  emailRevenueDollars: number;
  emailUnsubscribes: number;
  smsDelivered: number;
  smsClicks: number;
  smsConversions: number;
  smsRevenueDollars: number;
  smsUnsubscribes: number;
}

// ─── Combined ─────────────────────────────────────────────────────────

export interface WeeklyReportData {
  weekRange: WeekRange;
  ads: AdsWeekData;
  shopify: ShopifyWeekData;
  social: SocialWeekData;
  emailSms?: EmailSmsWeekData;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function fmtDollars(v: number): string {
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtNum(v: number): string {
  return v.toLocaleString("en-US");
}

function fmtPct(v: number | null): string {
  if (v === null) return "N/A";
  return `${v.toFixed(2)}%`;
}

function fmtRoas(v: number | null): string {
  if (v === null) return "N/A";
  return `${v.toFixed(2)}x`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDateLabel(dateStr: string): string {
  const [, m, d] = dateStr.split("-");
  return `${MONTHS[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

// ─── Week range ───────────────────────────────────────────────────────

/**
 * Compute the previous full week (Monday–Sunday) relative to `now`.
 * If `now` is a Monday, returns the week that just ended (yesterday).
 */
export function computeWeekRange(now: Date): WeekRange {
  const today = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
  ));

  // Day of week: 0=Sun, 1=Mon, ..., 6=Sat
  const dow = today.getUTCDay();

  // Days since last Monday (today if Monday)
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;

  // This week's Monday
  const thisMonday = new Date(today);
  thisMonday.setUTCDate(today.getUTCDate() - daysSinceMonday);

  // Previous week: Monday to Sunday
  const prevMonday = new Date(thisMonday);
  prevMonday.setUTCDate(thisMonday.getUTCDate() - 7);

  const prevSunday = new Date(prevMonday);
  prevSunday.setUTCDate(prevMonday.getUTCDate() + 6);

  const start = prevMonday.toISOString().split("T")[0];
  const end = prevSunday.toISOString().split("T")[0];

  return {
    start,
    end,
    label: `${formatDateLabel(start)} – ${formatDateLabel(end)}`,
  };
}

// ─── Channel formatters ───────────────────────────────────────────────

export function formatAdsSummary(data: AdsWeekData): string {
  if (data.totalSpendDollars === 0) {
    return "No ad spend this week.";
  }

  const lines = [
    `Spend: ${fmtDollars(data.totalSpendDollars)} | Revenue: ${fmtDollars(data.totalRevenueDollars)} | ROAS: ${fmtRoas(data.roas)}`,
    `Impressions: ${fmtNum(data.totalImpressions)} | Clicks: ${fmtNum(data.totalClicks)} | CTR: ${fmtPct(data.ctr)}`,
    `Purchases: ${data.totalPurchases} | Cost/purchase: ${data.costPerPurchaseDollars !== null ? fmtDollars(data.costPerPurchaseDollars) : "N/A"}`,
  ];

  if (data.topCreatives.length > 0) {
    lines.push("");
    lines.push("Top creatives:");
    for (const c of data.topCreatives) {
      lines.push(`  - ${c.name}: ROAS ${fmtRoas(c.roas)}, spent ${fmtDollars(c.spendDollars)}, revenue ${fmtDollars(c.revenueDollars)}`);
    }
  }

  return lines.join("\n");
}

export function formatShopifySummary(data: ShopifyWeekData): string {
  if (data.totalOrders === 0) {
    return "No orders this week.";
  }

  const lines = [
    `${data.totalOrders} orders | ${fmtDollars(data.totalRevenueDollars)} revenue | AOV ${fmtDollars(data.avgOrderValueDollars)}`,
    `${data.subscriptionOrders} subscriptions (${fmtDollars(data.subscriptionRevenueDollars)})`,
  ];

  if (data.topProducts.length > 0) {
    lines.push("");
    lines.push("Top products:");
    for (const p of data.topProducts) {
      lines.push(`  - ${p.title} (${p.count} orders)`);
    }
  }

  return lines.join("\n");
}

export function formatSocialSummary(data: SocialWeekData): string {
  if (data.postsPublished === 0) {
    return "No posts published this week.";
  }

  const lines = [
    `${data.postsPublished} posts | Reach: ${fmtNum(data.totalReach)} | Engagement: ${fmtPct(data.avgEngagementRate)}`,
    `Saves: ${fmtNum(data.totalSaves)} | Shares: ${fmtNum(data.totalShares)}`,
  ];

  if (data.reelPlays > 0) {
    lines.push(`Reel plays: ${fmtNum(data.reelPlays)}`);
  }

  if (data.topPost) {
    const caption = data.topPost.caption
      ? data.topPost.caption.length > 100
        ? data.topPost.caption.slice(0, 100) + "..."
        : data.topPost.caption
      : "(no caption)";
    lines.push("");
    lines.push(`Best post (${data.topPost.format}, ${fmtPct(data.topPost.engagementRate)} engagement, ${data.topPost.saves} saves):`);
    lines.push(`  "${caption}"`);
    if (data.topPost.permalink) {
      lines.push(`  ${data.topPost.permalink}`);
    }
  }

  return lines.join("\n");
}

export function formatEmailSmsSummary(data: EmailSmsWeekData): string {
  const hasEmail = data.emailDelivered > 0;
  const hasSms = data.smsDelivered > 0;

  if (!hasEmail && !hasSms) {
    return "No email/SMS data for this week. Import Attentive reports with `!import attentive`.";
  }

  const lines: string[] = [];

  if (hasEmail) {
    const emailCtr = data.emailDelivered > 0
      ? ((data.emailClicks / data.emailDelivered) * 100).toFixed(2) + "%"
      : "N/A";
    lines.push(`*Email:* ${fmtNum(data.emailDelivered)} delivered | ${fmtNum(data.emailClicks)} clicks (${emailCtr}) | ${data.emailConversions} conversions | ${fmtDollars(data.emailRevenueDollars)} revenue`);
    if (data.emailUnsubscribes > 0) {
      lines.push(`  Unsubscribes: ${fmtNum(data.emailUnsubscribes)}`);
    }
  }

  if (hasSms) {
    const smsCtr = data.smsDelivered > 0
      ? ((data.smsClicks / data.smsDelivered) * 100).toFixed(2) + "%"
      : "N/A";
    lines.push(`*SMS:* ${fmtNum(data.smsDelivered)} delivered | ${fmtNum(data.smsClicks)} clicks (${smsCtr}) | ${data.smsConversions} conversions | ${fmtDollars(data.smsRevenueDollars)} revenue`);
    if (data.smsUnsubscribes > 0) {
      lines.push(`  Unsubscribes: ${fmtNum(data.smsUnsubscribes)}`);
    }
  }

  if (hasEmail && hasSms) {
    const totalRevenue = data.emailRevenueDollars + data.smsRevenueDollars;
    const smsShare = totalRevenue > 0
      ? ((data.smsRevenueDollars / totalRevenue) * 100).toFixed(0)
      : "0";
    lines.push(`SMS drove ${smsShare}% of email/SMS revenue`);
  }

  return lines.join("\n");
}

export function formatWeeklyDataBlock(data: WeeklyReportData): string {
  const sections = [
    `# Weekly Performance: ${data.weekRange.label}`,
    "",
    "## Meta Ads",
    formatAdsSummary(data.ads),
    "",
    "## Shopify",
    formatShopifySummary(data.shopify),
    "",
    "## Email & SMS",
    data.emailSms ? formatEmailSmsSummary(data.emailSms) : "No Attentive data imported yet.",
    "",
    "## Organic Social",
    formatSocialSummary(data.social),
  ];

  return sections.join("\n");
}

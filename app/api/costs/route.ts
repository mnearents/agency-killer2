/**
 * Recurring cost entry (#34) — the one write surface on an otherwise read-only
 * dashboard, which is why it is the one behind a credential.
 *
 * GET  /api/costs — the open and closed rows
 * POST /api/costs — record a cost, closing the previous row if the amount moved
 *
 * Runs on the Node runtime because the auth check uses `node:crypto`. On the
 * edge runtime `timingSafeEqual` is unavailable, and the failure mode of
 * discovering that in production is an auth check that throws on every
 * request — or worse, one quietly rewritten to `===` to make it work.
 */

import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { recurringCosts } from "@/db/schema";
import { checkBasicAuth, CHALLENGE_HEADER } from "@/lib/basic-auth";
import { planRecurringCost } from "@/domain/economics/threepl-import";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorise(request: Request): NextResponse | null {
  const result = checkBasicAuth(request.headers.get("authorization"), {
    user: process.env.COST_FORM_USER,
    password: process.env.COST_FORM_PASSWORD,
  });
  if (result.ok) return null;

  // The reason is logged, never returned: telling a caller that the server has
  // no password configured tells them the wrong thing.
  console.error(`[costs] refused: ${result.reason}`);
  if (result.reason === "not_configured") {
    return NextResponse.json(
      { error: "Cost entry is not configured on this deployment." },
      { status: 503 },
    );
  }
  return NextResponse.json({ error: "Authentication required." }, {
    status: 401,
    headers: CHALLENGE_HEADER,
  });
}

export async function GET(request: Request) {
  const refusal = authorise(request);
  if (refusal) return refusal;

  const rows = await db()
    .select()
    .from(recurringCosts)
    .orderBy(desc(recurringCosts.effectiveFrom));

  return NextResponse.json({
    costs: rows.map((r: typeof recurringCosts.$inferSelect) => ({
      id: r.id,
      name: r.name,
      vendor: r.vendor,
      amountDollars: r.amountCents / 100,
      cadence: r.cadence,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      source: r.source,
      open: r.effectiveTo === null,
    })),
    returned: rows.length,
  });
}

const CADENCES = new Set(["monthly", "annual", "per_bill_period"]);

export async function POST(request: Request) {
  const refusal = authorise(request);
  if (refusal) return refusal;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const vendor = typeof body.vendor === "string" ? body.vendor.trim() : "";
  const cadence = typeof body.cadence === "string" ? body.cadence : "";
  const effectiveFrom = typeof body.effectiveFrom === "string" ? body.effectiveFrom : "";
  const amountDollars = Number(body.amountDollars);

  const problems: string[] = [];
  if (name === "") problems.push("name is required");
  if (!CADENCES.has(cadence)) problems.push(`cadence must be one of ${[...CADENCES].join(", ")}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) problems.push("effectiveFrom must be YYYY-MM-DD");
  // Zero is allowed — a cost genuinely dropping to nothing is a real event and
  // has to be recordable. Not-a-number is not.
  if (!Number.isFinite(amountDollars) || amountDollars < 0) {
    problems.push("amountDollars must be a number of zero or more");
  }
  if (problems.length > 0) {
    return NextResponse.json({ error: problems.join("; ") }, { status: 400 });
  }

  const existing = await db().select().from(recurringCosts).where(eq(recurringCosts.name, name));
  const plan = planRecurringCost(existing.find((r: typeof recurringCosts.$inferSelect) => r.effectiveTo === null), {
    name,
    amountCents: Math.round(amountDollars * 100),
    effectiveFrom,
    cadence,
    vendor: vendor === "" ? undefined : vendor,
  });

  if (plan.closeId !== null) {
    await db()
      .update(recurringCosts)
      .set({ effectiveTo: effectiveFrom })
      .where(eq(recurringCosts.id, plan.closeId));
  }
  if (plan.insert !== null) {
    await db().insert(recurringCosts).values({ ...plan.insert, source: "manual" });
  }

  return NextResponse.json({
    action: plan.action,
    previousDollars: plan.previousCents === null ? null : plan.previousCents / 100,
  });
}

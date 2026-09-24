/**
 * Attentive browser agent — uses Playwright to log into Attentive,
 * navigate to reports, and download CSV exports.
 *
 * Attentive has no API and requires SMS 2FA, so this agent:
 * 1. Tries saved session cookies first (no login needed)
 * 2. If expired, does full login → detects 2FA → asks Slack for code
 * 3. Saves cookies to DB after successful login for next run
 *
 * Credentials: ATTENTIVE_AGENT_USERNAME, ATTENTIVE_AGENT_PASSWORD
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Db } from "@/db/client";
import { agentSessions } from "@/db/schema";
import {
  parseStoredSession,
  serialiseSession,
  diagnoseSession,
  type SessionRecord,
  type SessionDiagnosis,
} from "./attentive-session";
import { eq, sql } from "drizzle-orm";

const ATTENTIVE_BASE = "https://ui.attentivemobile.com";
const LOGIN_URL = `${ATTENTIVE_BASE}/signin`;

const report = (slug: string) => `${ATTENTIVE_BASE}/analytics/reports/library/${slug}`;

const CAMPAIGN_PERFORMANCE_URL = report("campaign-performance-aggregate-group");
const ATTRIBUTED_REVENUE_URL = report("attributed-revenue");

/**
 * The detail reports #23 asks for. Slugs read off the live report library on
 * 2026-09-18 — `/analytics/reports` lists them; `/analytics/reports/library`
 * on its own renders nothing.
 *
 * `campaign-performance-aggregate-group`, which the two exports above use, is
 * an intentionally aggregate report: one row per day per channel, no campaign
 * name. These carry the name, the segment, the journey step and the cost.
 */
const CAMPAIGN_MESSAGE_URL = report("campaign-aggregate-performance-aggregate-group");
const CAMPAIGN_SEGMENT_URL = report("campaign-performance-by-segment");
const JOURNEY_MESSAGE_URL = report("journeys-message-level-performance-v2");
const MESSAGE_COST_URL = report("daily-message-cost");

const SESSION_ID = "attentive";

export interface AttentiveAgentConfig {
  username: string;
  password: string;
  db: Db;
  /** Send a message to Slack and wait for a reply (for 2FA codes) */
  askSlack?: (message: string) => Promise<string | null>;
  headless?: boolean;
}

export interface AttentiveExportResult {
  campaignCsv: string | null;
  revenueCsv: string | null;
  /** Per-campaign, per-message — carries the campaign name and unsubscribes. */
  campaignMessageCsv: string | null;
  /** The same sends broken out by the audience they went to. */
  campaignSegmentCsv: string | null;
  /** Per-message-within-journey. Where silent ongoing loss lives (#23). */
  journeyMessageCsv: string | null;
  /** Daily SMS cost, split by source. Feeds #34. */
  messageCostCsv: string | null;
  errors: string[];
}

// ─── Cookie persistence ───────────────────────────────────────────────

interface SessionData {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  localStorage?: Record<string, string>;
}

async function loadSession(db: Db): Promise<SessionRecord | null> {
  try {
    const [row] = await db
      .select({ cookiesJson: agentSessions.cookiesJson })
      .from(agentSessions)
      .where(eq(agentSessions.id, SESSION_ID))
      .limit(1);
    if (!row) return null;
    return parseStoredSession(row.cookiesJson);
  } catch {
    return null;
  }
}

async function saveSession(db: Db, record: SessionRecord): Promise<void> {
  await db
    .insert(agentSessions)
    .values({ id: SESSION_ID, cookiesJson: serialiseSession(record), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: agentSessions.id,
      set: {
        cookiesJson: sql`EXCLUDED.cookies_json`,
        updatedAt: sql`NOW()`,
      },
    });
}

/**
 * Snapshots sessionStorage for every origin the context has open.
 *
 * `storageState()` does not include it, and it is the one place an SPA can
 * keep a token that neither cookies nor localStorage would show — which is
 * the remaining candidate here, since the stored session has no auth cookie
 * at all.
 */
async function captureSessionStorage(
  pages: { url(): string; evaluate: <T>(fn: () => T) => Promise<T> }[],
): Promise<Record<string, Record<string, string>>> {
  const byOrigin: Record<string, Record<string, string>> = {};
  for (const page of pages) {
    let origin: string;
    try {
      origin = new URL(page.url()).origin;
    } catch {
      continue;
    }
    if (origin === "null" || byOrigin[origin]) continue;
    try {
      byOrigin[origin] = await page.evaluate(() => {
        const out: Record<string, string> = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key) out[key] = sessionStorage.getItem(key) ?? "";
        }
        return out;
      });
    } catch {
      // A page that navigated away mid-capture is not worth failing the run.
    }
  }
  return byOrigin;
}

// ─── Main export function ─────────────────────────────────────────────

export async function exportAttentiveReports(
  config: AttentiveAgentConfig
): Promise<AttentiveExportResult> {
  const errors: string[] = [];
  let browser: Browser | null = null;
  const exported: Record<string, string | null> = {
    campaignCsv: null,
    revenueCsv: null,
    campaignMessageCsv: null,
    campaignSegmentCsv: null,
    journeyMessageCsv: null,
    messageCostCsv: null,
  };

  try {
    console.log("[attentive-agent] Launching browser...");
    browser = await chromium.launch({
      headless: config.headless ?? true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // The saved session is loaded BEFORE the context, because storageState is
    // consumed at construction. The previous code created a bare context and
    // then restored localStorage by navigating and calling setItem — which
    // runs after the app has booted and already read it.
    const savedSession = await loadSession(config.db);
    let priorDiagnosis: SessionDiagnosis | null = null;
    if (savedSession) {
      priorDiagnosis = diagnoseSession(savedSession);
      console.log(
        `[attentive-agent] Saved session: ${priorDiagnosis.cookies} cookies ` +
          `(${priorDiagnosis.httpOnlyCookies} httpOnly), ` +
          `${priorDiagnosis.localStorageKeys} localStorage, ` +
          `${priorDiagnosis.sessionStorageKeys} sessionStorage`
      );
      // Said plainly rather than inferred from a 2FA prompt ten minutes later.
      if (!priorDiagnosis.couldAuthenticate) {
        console.error(`[attentive-agent] Saved session cannot authenticate. ${priorDiagnosis.reason}`);
      }
    } else {
      console.log("[attentive-agent] No saved session found");
    }

    const context = await browser.newContext({
      acceptDownloads: true,
      storageState: savedSession ? (savedSession.storageState as never) : undefined,
    });

    // sessionStorage is not part of storageState, so it is injected before any
    // script runs rather than after the app has booted.
    const restoredSessionStorage = savedSession?.sessionStorage ?? {};
    if (Object.keys(restoredSessionStorage).length > 0) {
      await context.addInitScript((byOrigin: Record<string, Record<string, string>>) => {
        const store = byOrigin[window.location.origin];
        if (!store) return;
        for (const [key, value] of Object.entries(store)) {
          try {
            sessionStorage.setItem(key, value);
          } catch {
            // A storage quota or a sandboxed origin is not worth failing over.
          }
        }
      }, restoredSessionStorage);
    }

    let authenticated = false;
    if (savedSession && priorDiagnosis?.couldAuthenticate) {
      const testPage = await context.newPage();
      await testPage.goto(CAMPAIGN_PERFORMANCE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await testPage.waitForTimeout(5000);

      const url = testPage.url();
      console.log(`[attentive-agent] Session test URL: ${url}`);
      if (!url.includes("/signin") && !url.includes("/2fa")) {
        console.log("[attentive-agent] Saved session is valid");
        authenticated = true;
      } else {
        console.log("[attentive-agent] Saved session expired, doing fresh login");
      }
      await testPage.close();
    }

    if (!authenticated) {
      const page = await context.newPage();
      await loginWith2FA(page, config);

      // storageState captures cookies for every domain the context touched,
      // httpOnly included, plus localStorage per origin. sessionStorage is
      // captured separately because storageState omits it.
      const storageState = await context.storageState();
      const sessionStorage = await captureSessionStorage(context.pages());

      const record: SessionRecord = {
        version: 2,
        storageState: storageState as never,
        sessionStorage,
        capturedAt: new Date().toISOString(),
      };

      const diagnosis = diagnoseSession(record);
      await saveSession(config.db, record);

      console.log(
        `[attentive-agent] Saved session: ${diagnosis.cookies} cookies ` +
          `(${diagnosis.httpOnlyCookies} httpOnly), ${diagnosis.localStorageKeys} localStorage, ` +
          `${diagnosis.sessionStorageKeys} sessionStorage`
      );
      console.log(`[attentive-agent] auth-candidate cookies: ${diagnosis.authCandidateCookies.join(", ") || "(none)"}`);

      // The whole point of #95. If this fires, the next run needs a 2FA code
      // again and we now know that BEFORE it happens rather than after.
      if (!diagnosis.couldAuthenticate) {
        const message = `Session captured after login contains nothing that can authenticate. ${diagnosis.reason}`;
        console.error(`[attentive-agent] ${message}`);
        errors.push(message);
      }

      await page.close();
    }

    // Now export reports using the authenticated context
    const page = await context.newPage();

    // Each report is independent: one failing must not cost the other five,
    // and every failure is named rather than folded into a count.
    const wanted: Array<[keyof AttentiveExportResult, string, string]> = [
      ["campaignCsv", CAMPAIGN_PERFORMANCE_URL, "Campaign Performance"],
      ["revenueCsv", ATTRIBUTED_REVENUE_URL, "Attributed Revenue"],
      ["campaignMessageCsv", CAMPAIGN_MESSAGE_URL, "Detailed Campaign Message Performance"],
      ["campaignSegmentCsv", CAMPAIGN_SEGMENT_URL, "Campaign Performance by Segment"],
      ["journeyMessageCsv", JOURNEY_MESSAGE_URL, "Journey Message-Level Performance"],
      ["messageCostCsv", MESSAGE_COST_URL, "Daily Message Cost"],
    ];

    for (const [key, url, name] of wanted) {
      try {
        const csv = await exportReport(page, url, name);
        exported[key] = csv;
        console.log(`[attentive-agent] ${name}: ${csv.split("\n").length} lines`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${name} export failed: ${msg}`);
        console.error(`[attentive-agent] ${name} failed: ${msg}`);
      }
    }

    await context.close();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Agent failed: ${msg}`);
    console.error(`[attentive-agent] Fatal error: ${msg}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  return {
    campaignCsv: exported.campaignCsv,
    revenueCsv: exported.revenueCsv,
    campaignMessageCsv: exported.campaignMessageCsv,
    campaignSegmentCsv: exported.campaignSegmentCsv,
    journeyMessageCsv: exported.journeyMessageCsv,
    messageCostCsv: exported.messageCostCsv,
    errors,
  };
}

// ─── Login with 2FA ───────────────────────────────────────────────────

/**
 * Asks Slack for the code, saying which one to use.
 *
 * Two codes arrive with different values — Attentive sends one on reaching the
 * 2FA page and another when the resend button is clicked — and only the newer
 * one works. Without the timestamp there is no way to tell them apart from the
 * phone, which is why the first code sent is usually the one typed back and
 * why verification then fails.
 */
async function askForCode(
  config: AttentiveAgentConfig,
  requestedAt: Date,
  attempt: number,
): Promise<string | null> {
  if (!config.askSlack) return null;
  const time = requestedAt.toLocaleTimeString("en-US", {
    timeZone: "America/Denver",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  const preamble = attempt > 1
    ? `That code did not work — Attentive has sent a new one (attempt ${attempt}). `
    : "Attentive needs a 2FA code to finish logging in. ";
  return config.askSlack(
    `${preamble}` +
      `*Use the code that arrives at or after ${time} MT and ignore any earlier one* — ` +
      `Attentive sends two with different values and only the newer works. ` +
      `Reply here with the 6 digits.`,
  );
}

async function loginWith2FA(page: Page, config: AttentiveAgentConfig): Promise<void> {
  console.log("[attentive-agent] Starting login...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("#email", { timeout: 15000 });

  // Enter email and click Continue
  await page.fill("#email", config.username);
  await page.click('[data-client-ui-id="login-button"]');

  // Wait for password field
  await page.waitForSelector('#password[aria-hidden="false"]', { timeout: 10000 });

  // Enter password and sign in
  await page.fill("#password", config.password);
  await page.waitForSelector('[data-client-ui-id="login-button"]:not([disabled])', { timeout: 5000 });
  await page.click('[data-client-ui-id="login-button"]');

  // Wait for navigation away from signin
  await page.waitForFunction(
    () => !window.location.pathname.includes("/signin"),
    { timeout: 30000 }
  );

  const postLoginUrl = page.url();
  console.log(`[attentive-agent] Post-login URL: ${postLoginUrl}`);

  // Check if we hit 2FA
  if (postLoginUrl.includes("/2fa")) {
    console.log("[attentive-agent] 2FA required, asking Slack for code...");

    if (!config.askSlack) {
      throw new Error("2FA required but no Slack callback configured. Set SLACK_REPORT_CHANNEL and restart.");
    }

    // Attentive sends a code on arriving at /2fa, and clicking its "Text me"
    // button sends a SECOND one — which is why two codes arrive with different
    // values and only the newer works. Rather than try to detect whether one
    // was already sent, the resend is deliberate and the timestamp of it is
    // what the message tells Matt to go by. Guessing wrong in the other
    // direction means no code arrives at all and the run hangs.
    const sendButton = await page.$('button:has-text("Send"), button:has-text("send code"), button:has-text("Text me")');
    let requestedAt = new Date();
    if (sendButton) {
      await sendButton.click();
      requestedAt = new Date();
      console.log("[attentive-agent] Requested a fresh SMS code");
      await page.waitForTimeout(2000);
    }

    // Up to three attempts. Sending the older of the two codes is the normal
    // mistake, and failing the whole run for it means waiting until tomorrow
    // — so a rejected code asks for a fresh one rather than throwing.
    const MAX_CODE_ATTEMPTS = 3;
    let verified = false;

    for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS && !verified; attempt++) {
      if (attempt > 1) {
        // A new code, so the timestamp in the next message is the new one.
        const resend = await page.$('button:has-text("Send"), button:has-text("send code"), button:has-text("Text me"), button:has-text("Resend")');
        if (resend) {
          await resend.click();
          requestedAt = new Date();
          await page.waitForTimeout(2000);
        }
      }

      const code = await askForCode(config, requestedAt, attempt);
      if (!code) {
        throw new Error(
          attempt === 1
            ? "No 2FA code received from Slack (timed out or no reply)"
            : `No 2FA code received from Slack on attempt ${attempt}`,
        );
      }

      const cleanCode = code.replace(/\D/g, "").slice(0, 6);
      console.log(`[attentive-agent] Received 2FA code, attempt ${attempt} (${cleanCode.length} digits)`);

      const codeInput = await page.$(
        '#verificationCode, input[name="verificationCode"], input[placeholder="XXXXXX"], input[name*="code"], input[name*="otp"]'
      );
      if (codeInput) {
        await codeInput.fill("");
        await codeInput.fill(cleanCode);
      } else {
        const digitInputs = await page.$$('input[maxlength="1"]');
        if (digitInputs.length >= 6) {
          for (let i = 0; i < 6; i++) await digitInputs[i].fill(cleanCode[i] ?? "");
        } else {
          throw new Error("Could not find 2FA code input field");
        }
      }

      const submitButton = await page.$(
        'button[type="submit"], button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue"), button:has-text("Sign in")'
      );
      if (submitButton) {
        await submitButton.click();
      } else {
        await page.keyboard.press("Enter");
      }

      try {
        await page.waitForFunction(
          () => !window.location.pathname.includes("/2fa") && !window.location.pathname.includes("/signin"),
          { timeout: 30000 }
        );
        verified = true;
        console.log(`[attentive-agent] 2FA complete on attempt ${attempt}, URL: ${page.url()}`);
      } catch {
        const bodyText = (await page.textContent("body").catch(() => "")) ?? "";
        console.error(
          `[attentive-agent] Code rejected on attempt ${attempt} at ${page.url()}: ${bodyText.slice(0, 200)}`
        );
        if (attempt === MAX_CODE_ATTEMPTS) {
          throw new Error(
            `2FA failed after ${MAX_CODE_ATTEMPTS} codes — still at ${page.url()}. ` +
              `If the codes were being entered correctly this is not a wrong-code problem.`
          );
        }
      }
    }
  }

  // Give the SPA a moment to initialize
  await page.waitForTimeout(3000);
  console.log("[attentive-agent] Login complete");
}

/**
 * Remove Attentive's in-app marketing popups.
 *
 * Returns how many were removed so the caller can log it — a run that had to
 * clear a popup and one that did not are different runs, and if this number
 * starts climbing the popups are worth a real dismissal rather than a removal.
 */
async function dismissOverlays(page: Page): Promise<number> {
  return page.evaluate(() => {
    let removed = 0;
    const wrapper = document.getElementById("engagement-wrapper");
    if (wrapper) {
      wrapper.remove();
      removed++;
    }
    for (const el of Array.from(document.querySelectorAll("[data-engagement]"))) {
      el.remove();
      removed++;
    }
    return removed;
  });
}

// ─── Report export ────────────────────────────────────────────────────

async function exportReport(page: Page, reportUrl: string, reportName: string): Promise<string> {
  console.log(`[attentive-agent] Navigating to ${reportName}...`);
  await page.goto(reportUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000);

  const currentUrl = page.url();
  if (currentUrl.includes("/signin") || currentUrl.includes("/2fa")) {
    throw new Error(`Session lost — redirected to ${currentUrl}`);
  }

  // Wait for the Export button
  try {
    await page.waitForSelector('button:has-text("Export")', { timeout: 30000 });
  } catch {
    const title = await page.title();
    const bodyText = await page.textContent("body").catch(() => "(could not read body)");
    console.error(`[attentive-agent] ${reportName}: Export button not found`);
    console.error(`[attentive-agent] URL: ${currentUrl}, Title: ${title}`);
    console.error(`[attentive-agent] Body preview: ${bodyText?.slice(0, 500)}`);
    throw new Error(`${reportName} page did not show Export button within 30s`);
  }

  // Attentive renders in-app marketing popups into #engagement-wrapper, and
  // they sit over the Export button. Playwright finds the button, reports it
  // "visible, enabled and stable", and then retries the click for thirty
  // seconds while the popup swallows every one — so the report fails with a
  // click timeout rather than anything that names the cause.
  //
  // Observed on every one of six reports on 2026-09-18, with a popup about
  // Product Affinity segments. The popups are dismissible and therefore
  // intermittent, which is worse: the sync works until someone is shown one.
  const overlays = await dismissOverlays(page);
  if (overlays > 0) {
    console.log(`[attentive-agent] Dismissed ${overlays} in-app popup(s) over ${reportName}`);
  }

  console.log(`[attentive-agent] Clicking Export for ${reportName}...`);

  const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await page.click('button:has-text("Export")');

  const download = await downloadPromise;
  const filePath = await download.path();
  if (!filePath) {
    throw new Error("Download completed but no file path available");
  }

  const fs = await import("fs/promises");
  const content = await fs.readFile(filePath, "utf-8");

  if (!content || content.trim().length === 0) {
    throw new Error("Downloaded file is empty");
  }

  return content;
}

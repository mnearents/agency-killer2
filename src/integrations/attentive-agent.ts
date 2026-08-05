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
import { eq, sql } from "drizzle-orm";

const ATTENTIVE_BASE = "https://ui.attentivemobile.com";
const LOGIN_URL = `${ATTENTIVE_BASE}/signin`;

const CAMPAIGN_PERFORMANCE_URL = `${ATTENTIVE_BASE}/analytics/reports/library/campaign-performance-aggregate-group`;
const ATTRIBUTED_REVENUE_URL = `${ATTENTIVE_BASE}/analytics/reports/library/attributed-revenue`;

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
  errors: string[];
}

// ─── Cookie persistence ───────────────────────────────────────────────

interface CookieData {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

async function loadCookies(db: Db): Promise<CookieData[] | null> {
  try {
    const [row] = await db
      .select({ cookiesJson: agentSessions.cookiesJson })
      .from(agentSessions)
      .where(eq(agentSessions.id, SESSION_ID))
      .limit(1);

    if (!row) return null;
    return JSON.parse(row.cookiesJson) as CookieData[];
  } catch {
    return null;
  }
}

async function saveCookies(db: Db, cookies: CookieData[]): Promise<void> {
  const json = JSON.stringify(cookies);
  await db
    .insert(agentSessions)
    .values({ id: SESSION_ID, cookiesJson: json, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: agentSessions.id,
      set: {
        cookiesJson: sql`EXCLUDED.cookies_json`,
        updatedAt: sql`NOW()`,
      },
    });
}

// ─── Main export function ─────────────────────────────────────────────

export async function exportAttentiveReports(
  config: AttentiveAgentConfig
): Promise<AttentiveExportResult> {
  const errors: string[] = [];
  let browser: Browser | null = null;
  let campaignCsv: string | null = null;
  let revenueCsv: string | null = null;

  try {
    console.log("[attentive-agent] Launching browser...");
    browser = await chromium.launch({
      headless: config.headless ?? true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({ acceptDownloads: true });

    // Try saved cookies first
    let authenticated = false;
    const savedCookies = await loadCookies(config.db);
    if (savedCookies && savedCookies.length > 0) {
      console.log("[attentive-agent] Loading saved session cookies...");
      await context.addCookies(savedCookies);

      // Test if session is still valid
      const testPage = await context.newPage();
      await testPage.goto(CAMPAIGN_PERFORMANCE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await testPage.waitForTimeout(3000);

      const url = testPage.url();
      if (!url.includes("/signin") && !url.includes("/2fa")) {
        console.log("[attentive-agent] Saved session is valid");
        authenticated = true;
      } else {
        console.log("[attentive-agent] Saved session expired, doing fresh login");
        await testPage.close();
      }
    }

    if (!authenticated) {
      // Fresh login with 2FA
      const page = await context.newPage();
      await loginWith2FA(page, config);

      // Save cookies for next run
      const cookies = await context.cookies();
      const cookieData: CookieData[] = cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      }));
      await saveCookies(config.db, cookieData);
      console.log(`[attentive-agent] Saved ${cookieData.length} session cookies`);
      await page.close();
    }

    // Now export reports using the authenticated context
    const page = await context.newPage();

    try {
      campaignCsv = await exportReport(page, CAMPAIGN_PERFORMANCE_URL, "Campaign Performance");
      console.log(`[attentive-agent] Campaign Performance: ${campaignCsv?.split("\n").length ?? 0} lines`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Campaign Performance export failed: ${msg}`);
      console.error(`[attentive-agent] Campaign Performance failed: ${msg}`);
    }

    try {
      revenueCsv = await exportReport(page, ATTRIBUTED_REVENUE_URL, "Attributed Revenue");
      console.log(`[attentive-agent] Attributed Revenue: ${revenueCsv?.split("\n").length ?? 0} lines`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Attributed Revenue export failed: ${msg}`);
      console.error(`[attentive-agent] Attributed Revenue failed: ${msg}`);
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

  return { campaignCsv, revenueCsv, errors };
}

// ─── Login with 2FA ───────────────────────────────────────────────────

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

    // If it's a 2FA setup page, we need to click through to get to the code entry
    // First, check if there's a "send code" button to trigger the SMS
    const sendButton = await page.$('button:has-text("Send"), button:has-text("send code"), button:has-text("Text me")');
    if (sendButton) {
      await sendButton.click();
      console.log("[attentive-agent] Triggered SMS code send");
      await page.waitForTimeout(2000);
    }

    // Ask Slack for the code
    const code = await config.askSlack(
      "Attentive needs a 2FA code to complete login. Check your phone for the SMS and reply with the 6-digit code here."
    );

    if (!code) {
      throw new Error("No 2FA code received from Slack (timed out or no reply)");
    }

    const cleanCode = code.replace(/\D/g, "").slice(0, 6);
    console.log(`[attentive-agent] Received 2FA code (${cleanCode.length} digits)`);

    // Find the code input and fill it
    // Try common selectors for 2FA code inputs
    const codeInput = await page.$(
      'input[type="text"], input[type="number"], input[type="tel"], input[name*="code"], input[name*="otp"], input[placeholder*="code"]'
    );

    if (codeInput) {
      await codeInput.fill(cleanCode);
    } else {
      // Some 2FA forms use individual digit inputs
      const digitInputs = await page.$$('input[maxlength="1"]');
      if (digitInputs.length >= 6) {
        for (let i = 0; i < 6; i++) {
          await digitInputs[i].fill(cleanCode[i]);
        }
      } else {
        throw new Error("Could not find 2FA code input field");
      }
    }

    // Submit the code
    const submitButton = await page.$(
      'button[type="submit"], button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue")'
    );
    if (submitButton) {
      await submitButton.click();
    }

    // Wait for navigation past 2FA
    await page.waitForFunction(
      () => !window.location.pathname.includes("/2fa") && !window.location.pathname.includes("/signin"),
      { timeout: 30000 }
    );

    console.log(`[attentive-agent] 2FA complete, URL: ${page.url()}`);
  }

  // Give the SPA a moment to initialize
  await page.waitForTimeout(3000);
  console.log("[attentive-agent] Login complete");
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

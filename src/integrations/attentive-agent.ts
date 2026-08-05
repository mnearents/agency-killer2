/**
 * Attentive browser agent — uses Playwright to log into Attentive,
 * navigate to reports, and download CSV exports.
 *
 * Attentive has no API, so this is the automated equivalent of
 * a human logging in and clicking Export.
 *
 * Credentials come from env vars: ATTENTIVE_AGENT_USERNAME, ATTENTIVE_AGENT_PASSWORD
 */

import { chromium, type Browser, type Page } from "playwright";

const ATTENTIVE_BASE = "https://ui.attentivemobile.com";
const LOGIN_URL = `${ATTENTIVE_BASE}/signin`;
const REPORTS_URL = `${ATTENTIVE_BASE}/reports`;

// Report URLs (navigated to from the reports library)
const CAMPAIGN_PERFORMANCE_URL = `${ATTENTIVE_BASE}/analytics/reports/library/campaign-performance-aggregate-group`;
const ATTRIBUTED_REVENUE_URL = `${ATTENTIVE_BASE}/analytics/reports/library/attributed-revenue`;

export interface AttentiveAgentConfig {
  username: string;
  password: string;
  headless?: boolean;
}

export interface AttentiveExportResult {
  campaignCsv: string | null;
  revenueCsv: string | null;
  errors: string[];
}

/**
 * Log into Attentive and export Campaign Performance + Attributed Revenue CSVs.
 * Returns the raw CSV content for each report.
 */
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

    const context = await browser.newContext({
      acceptDownloads: true,
    });
    const page = await context.newPage();

    // Step 1: Login
    await login(page, config.username, config.password);
    console.log("[attentive-agent] Login successful");

    // Step 2: Export Campaign Performance
    try {
      campaignCsv = await exportReport(page, CAMPAIGN_PERFORMANCE_URL, "Campaign Performance");
      console.log(`[attentive-agent] Campaign Performance: ${campaignCsv?.split("\n").length ?? 0} lines`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Campaign Performance export failed: ${msg}`);
      console.error(`[attentive-agent] Campaign Performance failed: ${msg}`);
    }

    // Step 3: Export Attributed Revenue
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

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("#email", { timeout: 15000 });

  // Step 1: Enter email and click Continue
  await page.fill("#email", username);
  await page.click('[data-client-ui-id="login-button"]');

  // Step 2: Wait for password field to appear
  await page.waitForSelector('#password[aria-hidden="false"]', { timeout: 10000 });

  // Step 3: Enter password and click Sign in
  await page.fill("#password", password);

  // Wait for Sign in button to be enabled
  await page.waitForSelector('[data-client-ui-id="login-button"]:not([disabled])', { timeout: 5000 });
  await page.click('[data-client-ui-id="login-button"]');

  // Wait for navigation away from signin page
  await page.waitForFunction(
    () => !window.location.pathname.includes("/signin"),
    { timeout: 30000 }
  );
}

async function exportReport(page: Page, reportUrl: string, reportName: string): Promise<string> {
  console.log(`[attentive-agent] Navigating to ${reportName}...`);
  await page.goto(reportUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Wait for the report table to load
  await page.waitForSelector("table", { timeout: 30000 });

  // Click the Export button
  console.log(`[attentive-agent] Clicking Export for ${reportName}...`);

  // Start waiting for download before clicking
  const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await page.click('button:has-text("Export")');

  // Wait for the download
  const download = await downloadPromise;

  // Read the downloaded file content
  const path = await download.path();
  if (!path) {
    throw new Error("Download completed but no file path available");
  }

  const fs = await import("fs/promises");
  const content = await fs.readFile(path, "utf-8");

  if (!content || content.trim().length === 0) {
    throw new Error("Downloaded file is empty");
  }

  return content;
}

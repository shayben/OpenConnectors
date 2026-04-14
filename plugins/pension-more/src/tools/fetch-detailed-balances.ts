/**
 * fetch_detailed_balances — דוח יתרות מפורט
 *
 * Logs into my-account.more.co.il, navigates to the detailed balances
 * report, and scrapes the data into a normalized structure.
 */

import { chromium, type Browser, type Page } from "playwright";

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface FetchDetailedBalancesParams {
  idNumber: string;
  password: string;
  headless: boolean;
  proxy?: ProxyConfig;
}

/** A single fund/product line in the detailed balances report. */
export interface DetailedBalanceEntry {
  /** Product/fund name (e.g. "פנסיה מקיפה", "קרן השתלמות") */
  productName: string;
  /** Account or policy number */
  accountNumber: string;
  /** Employer name associated with this fund */
  employerName: string;
  /** Total accumulated balance in ILS */
  totalBalance: number;
  /** Employee contribution component */
  employeeContribution: number;
  /** Employer contribution component */
  employerContribution: number;
  /** Severance pay component (פיצויים) */
  severanceComponent: number;
  /** Investment returns component */
  investmentReturns: number;
  /** Investment track name */
  investmentTrack: string;
  /** Report date as shown on the page */
  reportDate: string;
}

/** Parse a Hebrew-formatted number like "1,234.56 ₪" or "1,234.56-" to a float. */
function parseHebrewNumber(text: string): number {
  const cleaned = text.replace(/[^\d.,-]/g, "");
  // Handle trailing minus sign (common in Hebrew financial formatting)
  const isNegative = cleaned.endsWith("-") || text.includes("-");
  const num = parseFloat(cleaned.replace(/,/g, "").replace(/-/g, ""));
  return isNaN(num) ? 0 : isNegative ? -Math.abs(num) : num;
}

/**
 * Log into the Mor personal area.
 *
 * The login page is at https://my-account.more.co.il/login.
 * Fields: Israeli ID (תעודת זהות) and password.
 * After submit the site may send an OTP via SMS — in --no-headless
 * mode the browser stays open for you to type it in manually.
 */
async function login(
  page: Page,
  idNumber: string,
  password: string
): Promise<void> {
  await page.goto("https://my-account.more.co.il/login", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  // Wait for the page to finish rendering (SPA hydration)
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {
    // networkidle can be flaky on SPAs — continue anyway
  });

  // Fill ID number — try multiple selector strategies
  const idInput =
    page.locator('input[type="text"], input[type="tel"], input[name*="id" i], input[name*="tz" i]').first();
  await idInput.waitFor({ timeout: 10_000 });
  await idInput.fill(idNumber);

  // Fill password
  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.fill(password);

  // Submit
  const submitButton = page.locator(
    'button[type="submit"], button:has-text("כניסה"), button:has-text("התחבר"), input[type="submit"]'
  ).first();
  await submitButton.click();

  // Wait for navigation away from the login page.
  // If OTP is required, the user has 2 minutes to enter it manually
  // (only relevant when running --no-headless).
  await page.waitForURL((url) => !url.pathname.includes("/login"), {
    timeout: 120_000,
  });

  // Give the post-login SPA a moment to settle
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
}

/**
 * Navigate to the "דוח יתרות מפורט" report page.
 */
async function navigateToDetailedBalances(page: Page): Promise<void> {
  // Try clicking a link/menu item that contains the report name.
  // Israeli finance sites commonly use text links or sidebar menus.
  const reportLink = page.locator(
    'a:has-text("דוח יתרות מפורט"), button:has-text("דוח יתר��ת מפורט"), ' +
    '[class*="menu"] :has-text("דוח יתרות מפורט"), ' +
    'a:has-text("יתרות מפורט"), button:has-text("יתרות מפורט")'
  ).first();

  // If a direct link exists, click it
  const linkVisible = await reportLink.isVisible({ timeout: 5_000 }).catch(() => false);
  if (linkVisible) {
    await reportLink.click();
  } else {
    // Try opening a reports/statements menu first
    const reportsMenu = page.locator(
      'a:has-text("דוחות"), button:has-text("��וחות"), ' +
      'a:has-text("מידע על חשבון"), button:has-text("מידע על חשבון"), ' +
      '[class*="menu"] :has-text("דוחות")'
    ).first();

    const menuVisible = await reportsMenu.isVisible({ timeout: 5_000 }).catch(() => false);
    if (menuVisible) {
      await reportsMenu.click();
      await page.waitForTimeout(1_000);
      // Now look for the detailed balances option inside the expanded menu
      await page.locator(':has-text("יתרות מפורט")').first().click();
    } else {
      // Last resort: try direct URL patterns common to Mor
      await page.goto("https://my-account.more.co.il/personalarea/balances", {
        timeout: 15_000,
      });
    }
  }

  // Wait for report content to appear
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  // Wait for a table or data container
  await page.locator("table, [class*='table'], [class*='balance'], [class*='report']")
    .first()
    .waitFor({ timeout: 15_000 });
}

/**
 * Scrape the detailed balances table from the current page.
 *
 * Uses $$eval (which provides proper DOM types in the browser callback)
 * to extract table data, then normalizes it into DetailedBalanceEntry[].
 */
async function scrapeDetailedBalances(
  page: Page
): Promise<DetailedBalanceEntry[]> {
  // Try to find the report date from the page
  const reportDate = await page
    .locator('[class*="date"], :has-text("נכון ל"), :has-text("תאריך דוח")')
    .first()
    .textContent({ timeout: 5_000 })
    .then((t) => t?.replace(/[^0-9./\-]/g, "").trim() ?? "")
    .catch(() => new Date().toISOString().split("T")[0]!);

  // Scrape table data using Playwright's locator API (avoids DOM type issues).
  let rows: string[][] = [];

  // Strategy 1: HTML <table> — find rows with <td> cells
  const tableRows = page.locator("table tbody tr, table tr:not(:first-child)");
  const tableRowCount = await tableRows.count().catch(() => 0);

  if (tableRowCount > 0) {
    for (let i = 0; i < tableRowCount; i++) {
      const row = tableRows.nth(i);
      const cells = row.locator("td");
      const cellCount = await cells.count();
      const cellTexts: string[] = [];
      for (let j = 0; j < cellCount; j++) {
        const text = await cells.nth(j).textContent() ?? "";
        cellTexts.push(text.trim());
      }
      if (cellTexts.length > 0) {
        rows.push(cellTexts);
      }
    }
  }

  // Strategy 2: div-based grid/list (common in SPAs)
  if (rows.length === 0) {
    const gridRows = page.locator('[role="row"], [class*="row"]:not([class*="header"])');
    const gridRowCount = await gridRows.count().catch(() => 0);

    for (let i = 0; i < gridRowCount; i++) {
      const row = gridRows.nth(i);
      const cells = row.locator('[role="gridcell"], [class*="cell"], > div, > span');
      const cellCount = await cells.count();
      const cellTexts: string[] = [];
      for (let j = 0; j < cellCount; j++) {
        const text = await cells.nth(j).textContent() ?? "";
        cellTexts.push(text.trim());
      }
      if (cellTexts.length > 0) {
        rows.push(cellTexts);
      }
    }
  }

  // Map raw cell arrays into DetailedBalanceEntry objects.
  const entries: DetailedBalanceEntry[] = [];

  for (const cells of rows) {
    if (cells.length < 3) continue;
    if (cells.every((c) => !c || c.length < 2)) continue;

    entries.push({
      productName: cells[0] ?? "",
      accountNumber: cells[1] ?? "",
      employerName: cells[2] ?? "",
      totalBalance: parseHebrewNumber(cells[3] ?? "0"),
      employeeContribution: parseHebrewNumber(cells[4] ?? "0"),
      employerContribution: parseHebrewNumber(cells[5] ?? "0"),
      severanceComponent: parseHebrewNumber(cells[6] ?? "0"),
      investmentReturns: parseHebrewNumber(cells[7] ?? "0"),
      investmentTrack: cells[8] ?? "",
      reportDate,
    });
  }

  return entries;
}

export async function fetchDetailedBalances(
  params: FetchDetailedBalancesParams
): Promise<DetailedBalanceEntry[]> {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({
      headless: params.headless,
      proxy: params.proxy,
    });
    const context = await browser.newContext({
      locale: "he-IL",
      timezoneId: "Asia/Jerusalem",
    });
    const page = await context.newPage();

    await login(page, params.idNumber, params.password);
    await navigateToDetailedBalances(page);
    const balances = await scrapeDetailedBalances(page);

    await context.close();
    return balances;
  } catch (err) {
    // Screenshot on failure for debugging
    try {
      const pages = browser?.contexts()[0]?.pages();
      if (pages?.[0]) {
        await pages[0].screenshot({
          path: "error-detailed-balances.png",
          fullPage: true,
        });
        console.error("Screenshot saved to error-detailed-balances.png");
      }
    } catch {
      // ignore screenshot errors
    }
    throw err;
  } finally {
    await browser?.close();
  }
}

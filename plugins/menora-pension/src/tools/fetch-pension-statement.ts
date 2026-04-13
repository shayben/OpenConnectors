/**
 * fetch_pension_statement tool — Menora Mivtachim
 *
 * Playwright extraction pattern:
 *   1. Launch browser
 *   2. Log into the Menora Mivtachim personal portal
 *   3. Navigate to the pension fund / provident fund summary page
 *   4. Scrape current balance, YTD contributions, and returns
 *   5. Normalize into a structured PensionStatement object
 *   6. Close browser and return data
 *
 * Portal: https://www.menora.co.il / https://pensioni.menora.co.il
 */

import { chromium, type Browser, type Page } from "playwright";

export interface FetchPensionStatementParams {
  nationalId: string;
  password: string;
  year?: number;
  headless: boolean;
}

export interface PensionFund {
  /** Fund name (e.g. "קרן פנסיה מקיפה") */
  name: string;
  /** Fund type: pension, provident, or study */
  type: "pension" | "provident" | "study";
  /** Policy or account number */
  policyNumber: string;
  /** Current total balance in ILS */
  balance: number;
  /** Employee contributions YTD in ILS */
  employeeContributions: number;
  /** Employer contributions YTD in ILS */
  employerContributions: number;
  /** Investment returns YTD in ILS */
  investmentReturns: number;
  /** Return rate YTD as a percentage */
  returnRatePercent: number;
  /** Projected monthly pension at retirement age */
  projectedMonthlyPension?: number;
}

export interface PensionStatement {
  /** Statement year */
  year: number;
  /** Statement date */
  asOfDate: string;
  /** Institution name */
  institution: string;
  /** Policyholder national ID */
  nationalId: string;
  /** All funds held at this institution */
  funds: PensionFund[];
  /** Total balance across all funds */
  totalBalance: number;
}

/**
 * Log into the Menora Mivtachim personal portal.
 *
 * Real implementation:
 *   - Navigate to https://pensioni.menora.co.il/Login
 *   - Fill national ID and password
 *   - Handle SMS OTP if prompted
 *   - Wait for the dashboard
 */
async function loginToMenora(
  page: Page,
  nationalId: string,
  _password: string
): Promise<void> {
  // Real plugin:
  // await page.goto('https://pensioni.menora.co.il/Login');
  // await page.fill('input#Id', nationalId);
  // await page.fill('input#Password', _password);
  // await page.click('button#loginBtn');
  // await page.waitForSelector('.pension-dashboard', { timeout: 30000 });

  await page.goto("about:blank");
}

/**
 * Navigate to the pension fund summary page.
 *
 * Real implementation:
 *   - Click "קרנות פנסיה" or "סיכום חשבון"
 *   - Optionally filter by year using the year selector
 *   - Wait for fund balance cards to load
 */
async function navigateToPensionSummary(
  _page: Page,
  _year: number
): Promise<void> {
  // Real plugin:
  // await _page.click('a[href*="pension-summary"]');
  // await _page.selectOption('select#yearFilter', String(_year));
  // await _page.waitForSelector('.fund-card');
}

/** Generate realistic mock pension data for Menora Mivtachim. */
function generateMockPensionStatement(
  nationalId: string,
  year: number
): PensionStatement {
  const pensionBalance = 320000 + Math.floor(Math.random() * 80000);
  const providentBalance = 95000 + Math.floor(Math.random() * 30000);

  const funds: PensionFund[] = [
    {
      name: "מנורה מבטחים פנסיה — קרן פנסיה מקיפה",
      type: "pension",
      policyNumber: `MEN-${nationalId.slice(-6)}-P`,
      balance: pensionBalance,
      employeeContributions: Math.round(pensionBalance * 0.055),
      employerContributions: Math.round(pensionBalance * 0.06),
      investmentReturns: Math.round(pensionBalance * 0.048),
      returnRatePercent: 4.8,
      projectedMonthlyPension: Math.round(pensionBalance * 0.004),
    },
    {
      name: "מנורה מבטחים גמל — קרן השתלמות",
      type: "study",
      policyNumber: `MEN-${nationalId.slice(-6)}-S`,
      balance: providentBalance,
      employeeContributions: Math.round(providentBalance * 0.025),
      employerContributions: Math.round(providentBalance * 0.075),
      investmentReturns: Math.round(providentBalance * 0.052),
      returnRatePercent: 5.2,
    },
  ];

  return {
    year,
    asOfDate: `${year}-12-31`,
    institution: "Menora Mivtachim",
    nationalId,
    funds,
    totalBalance: funds.reduce((sum, f) => sum + f.balance, 0),
  };
}

export async function fetchPensionStatement(
  params: FetchPensionStatementParams
): Promise<PensionStatement> {
  let browser: Browser | undefined;
  const year = params.year ?? new Date().getFullYear();

  try {
    browser = await chromium.launch({ headless: params.headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    await loginToMenora(page, params.nationalId, params.password);
    await navigateToPensionSummary(page, year);

    const statement = generateMockPensionStatement(params.nationalId, year);

    await context.close();
    return statement;
  } finally {
    await browser?.close();
  }
}

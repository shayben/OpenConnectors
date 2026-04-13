/**
 * fetch_pension_statement tool — Harel Insurance & Finance
 *
 * Playwright extraction pattern:
 *   1. Launch browser
 *   2. Log into the Harel personal portal
 *   3. Navigate to the pension / provident fund summary page
 *   4. Scrape current balance, YTD contributions, and returns
 *   5. Normalize into a structured PensionStatement object
 *   6. Close browser and return data
 *
 * Portal: https://www.harel.co.il / https://digital.harel.co.il
 */

import { chromium, type Browser, type Page } from "playwright";

export interface FetchPensionStatementParams {
  nationalId: string;
  password: string;
  year?: number;
  headless: boolean;
}

export interface PensionFund {
  /** Fund name (e.g. "הראל פנסיה מקיפה") */
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
 * Log into the Harel personal portal.
 *
 * Real implementation:
 *   - Navigate to https://digital.harel.co.il/login
 *   - Fill national ID and password
 *   - Handle SMS OTP if prompted
 *   - Wait for the dashboard
 */
async function loginToHarel(
  page: Page,
  nationalId: string,
  _password: string
): Promise<void> {
  // Real plugin:
  // await page.goto('https://digital.harel.co.il/login');
  // await page.fill('input#userId', nationalId);
  // await page.fill('input#password', _password);
  // await page.click('button#loginSubmit');
  // await page.waitForSelector('.dashboard-container', { timeout: 30000 });

  await page.goto("about:blank");
}

/**
 * Navigate to the pension fund summary page.
 *
 * Real implementation:
 *   - Click "פנסיה וגמל" from the navigation
 *   - Optionally filter by year
 *   - Wait for fund cards to load
 */
async function navigateToPensionSummary(
  _page: Page,
  _year: number
): Promise<void> {
  // Real plugin:
  // await _page.click('nav a[href*="pension"]');
  // await _page.selectOption('select#reportYear', String(_year));
  // await _page.waitForSelector('.fund-summary-card');
}

/** Generate realistic mock pension data for Harel. */
function generateMockPensionStatement(
  nationalId: string,
  year: number
): PensionStatement {
  const pensionBalance = 290000 + Math.floor(Math.random() * 90000);
  const studyFundBalance = 110000 + Math.floor(Math.random() * 40000);

  const funds: PensionFund[] = [
    {
      name: "הראל פנסיה מקיפה",
      type: "pension",
      policyNumber: `HAR-${nationalId.slice(-6)}-P`,
      balance: pensionBalance,
      employeeContributions: Math.round(pensionBalance * 0.055),
      employerContributions: Math.round(pensionBalance * 0.065),
      investmentReturns: Math.round(pensionBalance * 0.051),
      returnRatePercent: 5.1,
      projectedMonthlyPension: Math.round(pensionBalance * 0.0042),
    },
    {
      name: "הראל גמל להשקעה — קרן השתלמות",
      type: "study",
      policyNumber: `HAR-${nationalId.slice(-6)}-S`,
      balance: studyFundBalance,
      employeeContributions: Math.round(studyFundBalance * 0.025),
      employerContributions: Math.round(studyFundBalance * 0.075),
      investmentReturns: Math.round(studyFundBalance * 0.059),
      returnRatePercent: 5.9,
    },
  ];

  return {
    year,
    asOfDate: `${year}-12-31`,
    institution: "Harel Insurance & Finance",
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

    await loginToHarel(page, params.nationalId, params.password);
    await navigateToPensionSummary(page, year);

    const statement = generateMockPensionStatement(params.nationalId, year);

    await context.close();
    return statement;
  } finally {
    await browser?.close();
  }
}

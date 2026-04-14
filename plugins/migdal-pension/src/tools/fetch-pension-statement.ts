/**
 * fetch_pension_statement tool — Migdal Insurance
 *
 * Playwright extraction pattern:
 *   1. Launch browser
 *   2. Log into the Migdal personal portal
 *   3. Navigate to the pension / provident fund summary page
 *   4. Scrape current balance, YTD contributions, and returns
 *   5. Normalize into a structured PensionStatement object
 *   6. Close browser and return data
 *
 * Portal: https://www.migdal.co.il / https://online.migdal.co.il
 */

import { chromium, type Browser, type Page } from "playwright";

export interface FetchPensionStatementParams {
  nationalId: string;
  password: string;
  year?: number;
  headless: boolean;
}

export interface PensionFund {
  /** Fund name (e.g. "מגדל פנסיה מקיפה") */
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
 * Log into the Migdal personal portal.
 *
 * Real implementation:
 *   - Navigate to https://online.migdal.co.il/login
 *   - Fill national ID and password
 *   - Handle SMS OTP if prompted
 *   - Wait for the dashboard
 */
async function loginToMigdal(
  page: Page,
  nationalId: string,
  _password: string
): Promise<void> {
  // Real plugin:
  // await page.goto('https://online.migdal.co.il/login');
  // await page.fill('input[name="teudat-zehut"]', nationalId);
  // await page.fill('input[name="password"]', _password);
  // await page.click('button.login-btn');
  // await page.waitForSelector('.portfolio-overview', { timeout: 30000 });

  await page.goto("about:blank");
}

/**
 * Navigate to the pension fund summary page.
 *
 * Real implementation:
 *   - Click "תיק ביטוח" or "פנסיה וחיסכון"
 *   - Select the year if needed
 *   - Wait for portfolio cards to load
 */
async function navigateToPensionSummary(
  _page: Page,
  _year: number
): Promise<void> {
  // Real plugin:
  // await _page.click('a[href*="portfolio"]');
  // await _page.selectOption('select#reportYear', String(_year));
  // await _page.waitForSelector('.product-card');
}

/** Generate realistic mock pension data for Migdal. */
function generateMockPensionStatement(
  nationalId: string,
  year: number
): PensionStatement {
  const pensionBalance = 310000 + Math.floor(Math.random() * 100000);
  const studyFundBalance = 85000 + Math.floor(Math.random() * 35000);

  const funds: PensionFund[] = [
    {
      name: "מגדל מקפת — קרן פנסיה מקיפה",
      type: "pension",
      policyNumber: `MIG-${nationalId.slice(-6)}-P`,
      balance: pensionBalance,
      employeeContributions: Math.round(pensionBalance * 0.055),
      employerContributions: Math.round(pensionBalance * 0.065),
      investmentReturns: Math.round(pensionBalance * 0.047),
      returnRatePercent: 4.7,
      projectedMonthlyPension: Math.round(pensionBalance * 0.0040),
    },
    {
      name: "מגדל גמל — קרן השתלמות",
      type: "study",
      policyNumber: `MIG-${nationalId.slice(-6)}-S`,
      balance: studyFundBalance,
      employeeContributions: Math.round(studyFundBalance * 0.025),
      employerContributions: Math.round(studyFundBalance * 0.075),
      investmentReturns: Math.round(studyFundBalance * 0.055),
      returnRatePercent: 5.5,
    },
  ];

  return {
    year,
    asOfDate: `${year}-12-31`,
    institution: "Migdal Insurance",
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

    await loginToMigdal(page, params.nationalId, params.password);
    await navigateToPensionSummary(page, year);

    const statement = generateMockPensionStatement(params.nationalId, year);

    await context.close();
    return statement;
  } finally {
    await browser?.close();
  }
}

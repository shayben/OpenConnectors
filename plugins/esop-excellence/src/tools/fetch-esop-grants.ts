/**
 * fetch_esop_grants tool — ESOP Excellence
 *
 * Playwright extraction pattern:
 *   1. Launch browser
 *   2. Log into the ESOP Excellence portal
 *   3. Navigate to the grants / equity summary page
 *   4. Scrape all grant records (options, RSUs, SARs)
 *   5. Normalize into structured EsopGrant objects
 *   6. Close browser and return data
 *
 * Portal: https://www.esopexcellence.com
 *
 * ESOP Excellence is Israel's leading ESOP administration and management
 * platform, serving tech companies and their employees for equity tracking,
 * exercises, and tax reporting under Israeli Section 102 rules.
 */

import { chromium, type Browser, type Page } from "playwright";

export interface FetchEsopGrantsParams {
  username: string;
  password: string;
  headless: boolean;
}

/** Type of equity grant */
export type GrantType = "ISO" | "NSO" | "RSU" | "SAR" | "ESPP";

/** Current status of a grant */
export type GrantStatus = "active" | "fully_vested" | "partially_vested" | "cancelled" | "exercised";

/** A single vesting event */
export interface VestingEvent {
  /** Date on which this tranche vests */
  vestDate: string;
  /** Number of shares/options vesting on this date */
  shares: number;
  /** Whether this tranche has already vested */
  vested: boolean;
}

/** A single equity grant */
export interface EsopGrant {
  /** Unique grant identifier */
  grantId: string;
  /** Grant type */
  type: GrantType;
  /** Date the grant was awarded */
  grantDate: string;
  /** Total number of shares/options awarded */
  totalShares: number;
  /** Number of shares/options that have vested */
  vestedShares: number;
  /** Number of shares/options that have been exercised */
  exercisedShares: number;
  /** Number of shares/options remaining to vest */
  unvestedShares: number;
  /** Exercise price per share in USD (for options/SARs) */
  exercisePriceUsd?: number;
  /** Current fair market value per share in USD */
  fmvPerShareUsd?: number;
  /** Vesting schedule (cliff + monthly/quarterly) */
  vestingSchedule: VestingEvent[];
  /** Israeli tax route: 102 Capital Gains or 102 Ordinary Income */
  taxRoute?: "102_capital_gains" | "102_ordinary_income" | "3i";
  /** Current status of the grant */
  status: GrantStatus;
  /** Expiration date */
  expirationDate?: string;
}

/** Summary of all equity grants for a participant */
export interface EsopSummary {
  /** Participant username / email */
  participant: string;
  /** Company name */
  companyName: string;
  /** All grants for this participant */
  grants: EsopGrant[];
  /** Total vested and unexercised value in USD (paper gain) */
  totalUnrealizedGainUsd: number;
  /** Date this data was fetched */
  asOfDate: string;
}

/**
 * Log into the ESOP Excellence portal.
 *
 * Real implementation:
 *   - Navigate to https://app.esopexcellence.com/login
 *   - Fill email and password
 *   - Handle MFA if prompted
 *   - Wait for the grants dashboard
 */
async function loginToEsopExcellence(
  page: Page,
  username: string,
  _password: string
): Promise<void> {
  // Real plugin:
  // await page.goto('https://app.esopexcellence.com/login');
  // await page.fill('input[type="email"]', username);
  // await page.fill('input[type="password"]', _password);
  // await page.click('button[type="submit"]');
  // await page.waitForSelector('.grants-dashboard', { timeout: 30000 });

  await page.goto("about:blank");
}

/**
 * Navigate to the grants list page.
 *
 * Real implementation:
 *   - Click "My Grants" from the navigation
 *   - Wait for the grants table to load
 */
async function navigateToGrants(_page: Page): Promise<void> {
  // Real plugin:
  // await _page.click('a[href*="grants"]');
  // await _page.waitForSelector('table.grants-table tbody tr');
}

/** Generate a realistic vesting schedule (1-year cliff + 36 monthly). */
function generateVestingSchedule(
  grantDate: string,
  totalShares: number
): VestingEvent[] {
  const start = new Date(grantDate);
  const today = new Date();
  const events: VestingEvent[] = [];

  // 25% cliff at 12 months
  const cliffDate = new Date(start);
  cliffDate.setFullYear(cliffDate.getFullYear() + 1);
  const cliffShares = Math.floor(totalShares * 0.25);
  events.push({
    vestDate: cliffDate.toISOString().split("T")[0]!,
    shares: cliffShares,
    vested: cliffDate <= today,
  });

  // Remaining 75% monthly over 36 months
  const monthlyShares = Math.floor((totalShares - cliffShares) / 36);
  for (let m = 1; m <= 36; m++) {
    const vestDate = new Date(cliffDate);
    vestDate.setMonth(vestDate.getMonth() + m);
    const shares = m === 36
      ? totalShares - cliffShares - monthlyShares * 35
      : monthlyShares;
    events.push({
      vestDate: vestDate.toISOString().split("T")[0]!,
      shares,
      vested: vestDate <= today,
    });
  }

  return events;
}

/** Generate realistic mock ESOP grants data. */
function generateMockEsopSummary(username: string): EsopSummary {
  const today = new Date();
  const fmvPerShare = 12.5 + Math.random() * 5;

  const grants: EsopGrant[] = [
    {
      grantId: "GRANT-2021-001",
      type: "ISO",
      grantDate: "2021-03-01",
      totalShares: 10000,
      vestedShares: 10000,
      exercisedShares: 2500,
      unvestedShares: 0,
      exercisePriceUsd: 2.5,
      fmvPerShareUsd: fmvPerShare,
      vestingSchedule: generateVestingSchedule("2021-03-01", 10000),
      taxRoute: "102_capital_gains",
      status: "fully_vested",
      expirationDate: "2031-03-01",
    },
    {
      grantId: "GRANT-2022-001",
      type: "RSU",
      grantDate: "2022-07-15",
      totalShares: 5000,
      vestedShares: 3125,
      exercisedShares: 0,
      unvestedShares: 1875,
      fmvPerShareUsd: fmvPerShare,
      vestingSchedule: generateVestingSchedule("2022-07-15", 5000),
      taxRoute: "102_capital_gains",
      status: "partially_vested",
      expirationDate: "2032-07-15",
    },
    {
      grantId: "GRANT-2023-001",
      type: "ISO",
      grantDate: "2023-11-01",
      totalShares: 8000,
      vestedShares: 2000,
      exercisedShares: 0,
      unvestedShares: 6000,
      exercisePriceUsd: 8.0,
      fmvPerShareUsd: fmvPerShare,
      vestingSchedule: generateVestingSchedule("2023-11-01", 8000),
      taxRoute: "102_capital_gains",
      status: "partially_vested",
      expirationDate: "2033-11-01",
    },
  ];

  const totalUnrealizedGainUsd = grants.reduce((sum, g) => {
    const exercisable = g.vestedShares - g.exercisedShares;
    const gain = exercisable * ((g.fmvPerShareUsd ?? 0) - (g.exercisePriceUsd ?? 0));
    return sum + Math.max(0, gain);
  }, 0);

  return {
    participant: username,
    companyName: "TechCo Israel Ltd",
    grants,
    totalUnrealizedGainUsd: Math.round(totalUnrealizedGainUsd * 100) / 100,
    asOfDate: today.toISOString().split("T")[0]!,
  };
}

export async function fetchEsopGrants(
  params: FetchEsopGrantsParams
): Promise<EsopSummary> {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: params.headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    await loginToEsopExcellence(page, params.username, params.password);
    await navigateToGrants(page);

    const summary = generateMockEsopSummary(params.username);

    await context.close();
    return summary;
  } finally {
    await browser?.close();
  }
}

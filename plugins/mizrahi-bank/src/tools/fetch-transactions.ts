/**
 * fetch_transactions tool — Mizrahi-Tefahot Bank
 *
 * Playwright extraction pattern:
 *   1. Launch browser
 *   2. Log into the Mizrahi-Tefahot online banking portal
 *   3. Navigate to the account transactions page
 *   4. Apply the date range filter
 *   5. Scrape transaction rows
 *   6. Normalize into the standard Transaction schema
 *   7. Close browser and return data
 *
 * The stub implementation generates realistic sample data instead of
 * hitting the real portal, but the Playwright scaffolding is structured
 * to be adapted for the actual site (https://www.mizrahi-tefahot.co.il).
 */

import { chromium, type Browser, type Page } from "playwright";
import type { Transaction } from "@openconnectors/schemas";

export interface FetchTransactionsParams {
  nationalId: string;
  password: string;
  fromDate: string;
  toDate: string;
  accountNumber?: string;
  headless: boolean;
}

/**
 * Log into the Mizrahi-Tefahot online banking portal.
 *
 * Real implementation:
 *   - Navigate to https://www.mizrahi-tefahot.co.il/he/bank/login/
 *   - Fill national ID and password
 *   - Handle SMS OTP if prompted
 *   - Wait for the account dashboard
 */
async function loginToMizrahi(
  page: Page,
  nationalId: string,
  _password: string
): Promise<void> {
  // Real plugin:
  // await page.goto('https://www.mizrahi-tefahot.co.il/he/bank/login/');
  // await page.fill('input[name="ID"]', nationalId);
  // await page.fill('input[name="password"]', _password);
  // await page.click('button[type="submit"]');
  // await page.waitForSelector('.account-dashboard', { timeout: 30000 });

  await page.goto("about:blank");
}

/**
 * Navigate to the transactions page and set the date filter.
 *
 * Real implementation:
 *   - Click the "Transactions" link from the dashboard
 *   - Select the account from the dropdown (if accountNumber provided)
 *   - Fill fromDate / toDate in the date pickers
 *   - Click "Search"
 *   - Wait for results table to load
 */
async function navigateToTransactions(
  _page: Page,
  _accountNumber: string | undefined,
  _fromDate: string,
  _toDate: string
): Promise<void> {
  // Real plugin:
  // await _page.click('a[href*="transactions"]');
  // if (_accountNumber) {
  //   await _page.selectOption('select#accountSelect', _accountNumber);
  // }
  // await _page.fill('input#fromDate', _fromDate);
  // await _page.fill('input#toDate', _toDate);
  // await _page.click('button#searchTransactions');
  // await _page.waitForSelector('table.transactions-table tbody tr');
}

/** Generate realistic Mizrahi-Tefahot bank transaction data. */
function generateMockTransactions(
  fromDate: string,
  toDate: string,
  accountNumber: string
): Transaction[] {
  const merchants = [
    { name: "רמי לוי שיווק השקמה", category: "food" as const, range: [-80, -500] },
    { name: "בזק בינלאומי", category: "utilities" as const, range: [-80, -200] },
    { name: "דלק תחנת דלק", category: "transportation" as const, range: [-120, -400] },
    { name: "מכבי שירותי בריאות", category: "healthcare" as const, range: [-50, -200] },
    { name: "Yes בידור", category: "entertainment" as const, range: [-60, -100] },
    { name: "משכורת", category: "income" as const, range: [18000, 30000] },
    { name: "ארנונה עיריית תל אביב", category: "housing" as const, range: [-600, -1500] },
    { name: "מזרחי-טפחות משכנתא", category: "housing" as const, range: [-3000, -7000] },
    { name: "עמלת בנק", category: "fee" as const, range: [-15, -40] },
    { name: "ביט העברה", category: "transfer" as const, range: [-200, -1000] },
    { name: "אמזון", category: "shopping" as const, range: [-50, -500] },
    { name: "קרן השתלמות", category: "savings" as const, range: [-500, -2000] },
  ];

  const from = new Date(fromDate);
  const to = new Date(toDate);
  const transactions: Transaction[] = [];
  let balance = 52800.0;

  const current = new Date(from);
  let txId = 1000;

  while (current <= to) {
    const count = 2 + Math.floor(Math.random() * 4);

    for (let i = 0; i < count && current <= to; i++) {
      const merchant = merchants[Math.floor(Math.random() * merchants.length)]!;
      const [min, max] = merchant.range;
      const amount =
        Math.round((min + Math.random() * (max - min)) * 100) / 100;

      balance = Math.round((balance + amount) * 100) / 100;

      transactions.push({
        id: `MIZRAHI-${txId++}`,
        date: current.toISOString().split("T")[0]!,
        amount,
        currency: "ILS",
        originalDescription: merchant.name,
        description: merchant.name,
        category: merchant.category,
        accountId: accountNumber,
        balance,
        pending: false,
      });

      current.setDate(current.getDate() + 1 + Math.floor(Math.random() * 2));
    }
  }

  return transactions;
}

export async function fetchTransactions(
  params: FetchTransactionsParams
): Promise<Transaction[]> {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: params.headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    await loginToMizrahi(page, params.nationalId, params.password);
    await navigateToTransactions(
      page,
      params.accountNumber,
      params.fromDate,
      params.toDate
    );

    const accountId = params.accountNumber ?? `IL-MIZRAHI-${params.nationalId.slice(-4)}`;
    const transactions = generateMockTransactions(
      params.fromDate,
      params.toDate,
      accountId
    );

    await context.close();
    return transactions;
  } finally {
    await browser?.close();
  }
}

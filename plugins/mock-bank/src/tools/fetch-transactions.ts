/**
 * fetch_transactions tool implementation
 *
 * Demonstrates the Playwright-based extraction pattern:
 *   1. Launch browser
 *   2. Log into the bank portal
 *   3. Navigate to the transactions page
 *   4. Scrape transaction rows
 *   5. Normalize into the standard Transaction schema
 *   6. Close browser and return data
 *
 * This mock implementation generates realistic sample data instead
 * of hitting a real portal, but the Playwright scaffolding is real
 * and ready to be adapted for actual institutions.
 */

import { chromium, type Browser, type Page } from "playwright";
import type { Transaction } from "@openconnectors/schemas";

export interface FetchTransactionsParams {
  username: string;
  password: string;
  fromDate: string;
  toDate: string;
  headless: boolean;
}

/**
 * Simulated bank login.
 *
 * In a real plugin, this navigates to the institution's login page,
 * fills in credentials, handles 2FA, and waits for the dashboard.
 */
async function loginToBank(
  page: Page,
  username: string,
  _password: string
): Promise<void> {
  // Real plugin: await page.goto('https://bank.example.com/login');
  // Real plugin: await page.fill('#username', username);
  // Real plugin: await page.fill('#password', password);
  // Real plugin: await page.click('#login-button');
  // Real plugin: await page.waitForNavigation();

  // Mock: navigate to a blank page to prove Playwright works
  await page.goto("about:blank");
  await page.evaluate(
    (user) => {
      document.title = `Mock Bank - ${user}`;
    },
    username
  );
}

/**
 * Generate realistic mock transactions for the date range.
 *
 * In a real plugin, this would scrape the transactions table
 * from the bank's web portal after login.
 */
function generateMockTransactions(
  fromDate: string,
  toDate: string
): Transaction[] {
  const merchants = [
    { name: "Shufersal Deal", category: "food" as const, range: [-50, -400] },
    { name: "HOT Telecom", category: "utilities" as const, range: [-100, -200] },
    { name: "Sonol Gas Station", category: "transportation" as const, range: [-100, -350] },
    { name: "Clalit Health", category: "healthcare" as const, range: [-30, -150] },
    { name: "Netflix Israel", category: "entertainment" as const, range: [-40, -60] },
    { name: "Salary Deposit", category: "income" as const, range: [15000, 25000] },
    { name: "Arnona Municipality", category: "housing" as const, range: [-500, -1200] },
    { name: "Psagot Investments", category: "investment" as const, range: [-1000, -5000] },
    { name: "Bank Fee", category: "fee" as const, range: [-10, -30] },
    { name: "Bit Transfer", category: "transfer" as const, range: [-100, -500] },
  ];

  const from = new Date(fromDate);
  const to = new Date(toDate);
  const transactions: Transaction[] = [];
  let balance = 45230.50;

  // Generate ~3 transactions per week in the range
  const current = new Date(from);
  let txId = 1000;

  while (current <= to) {
    // 2-4 transactions per week-chunk
    const count = 2 + Math.floor(Math.random() * 3);

    for (let i = 0; i < count && current <= to; i++) {
      const merchant = merchants[Math.floor(Math.random() * merchants.length)]!;
      const [min, max] = merchant.range;
      const amount =
        Math.round((min + Math.random() * (max - min)) * 100) / 100;

      balance = Math.round((balance + amount) * 100) / 100;

      transactions.push({
        id: `MOCK-${txId++}`,
        date: current.toISOString().split("T")[0]!,
        amount,
        currency: "ILS",
        originalDescription: merchant.name.toUpperCase(),
        description: merchant.name,
        category: merchant.category,
        accountId: "IL-MOCK-12345",
        balance,
        pending: false,
      });

      // Advance 1-3 days
      current.setDate(current.getDate() + 1 + Math.floor(Math.random() * 3));
    }
  }

  return transactions;
}

export async function fetchTransactions(
  params: FetchTransactionsParams
): Promise<Transaction[]> {
  let browser: Browser | undefined;

  try {
    // Launch a real Playwright browser — proves the plugin infrastructure works
    browser = await chromium.launch({ headless: params.headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Authenticate (mock)
    await loginToBank(page, params.username, params.password);

    // In a real plugin: navigate to transactions, scrape the table, etc.
    // Here we generate mock data that conforms to the Transaction schema.
    const transactions = generateMockTransactions(
      params.fromDate,
      params.toDate
    );

    await context.close();
    return transactions;
  } finally {
    await browser?.close();
  }
}

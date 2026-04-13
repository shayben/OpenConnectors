/**
 * fetch_tax_documents tool — ESOP Excellence
 *
 * Extracts annual tax documents related to equity compensation from the
 * ESOP Excellence portal. These include:
 *   - Section 102 election confirmation letters
 *   - Annual exercise report (for income tax reporting)
 *   - Capital gains summary for exercised options
 *
 * Real implementation would:
 *   - Navigate to the documents section
 *   - Select the requested tax year
 *   - Download available PDFs
 */

import { chromium, type Browser, type Page } from "playwright";
import type { Document } from "@openconnectors/schemas";

export interface FetchTaxDocumentsParams {
  username: string;
  password: string;
  year: number;
  headless: boolean;
}

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

async function navigateToTaxDocuments(
  _page: Page,
  _year: number
): Promise<void> {
  // Real plugin:
  // await _page.click('a[href*="tax-documents"]');
  // await _page.selectOption('select#taxYear', String(_year));
  // await _page.waitForSelector('.tax-document-list');
}

export async function fetchTaxDocuments(
  params: FetchTaxDocumentsParams
): Promise<Document[]> {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: params.headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    await loginToEsopExcellence(page, params.username, params.password);
    await navigateToTaxDocuments(page, params.year);

    const documents: Document[] = [
      {
        id: `ESOP-102-CONFIRM-${params.year}`,
        title: `Section 102 Election Confirmation — ${params.year}`,
        type: "tax_form",
        mimeType: "application/pdf",
        issuedDate: `${params.year}-01-31`,
        taxYear: params.year,
        institution: "ESOP Excellence",
        content: Buffer.from(
          `ESOP Excellence — Section 102 Confirmation ${params.year} — ${params.username}`
        ).toString("base64"),
        sizeBytes: 128,
        metadata: {
          documentType: "section_102_confirmation",
          country: "IL",
          taxRoute: "102_capital_gains",
        },
      },
      {
        id: `ESOP-EXERCISE-REPORT-${params.year}`,
        title: `Annual Exercise Report — ${params.year}`,
        type: "tax_form",
        mimeType: "application/pdf",
        issuedDate: `${params.year + 1}-01-31`,
        taxYear: params.year,
        institution: "ESOP Excellence",
        content: Buffer.from(
          `ESOP Excellence — Annual Exercise Report ${params.year} — ${params.username}`
        ).toString("base64"),
        sizeBytes: 256,
        metadata: {
          documentType: "annual_exercise_report",
          country: "IL",
        },
      },
    ];

    await context.close();
    return documents;
  } finally {
    await browser?.close();
  }
}

/**
 * fetch_tax_documents tool — Migdal Insurance
 *
 * Extracts the annual pension fund statement and related tax documents
 * from the Migdal personal portal.
 *
 * Real implementation would:
 *   - Navigate to the documents section
 *   - Select the requested tax year
 *   - Download the annual statement PDF
 *   - Optionally parse structured data from it
 */

import { chromium, type Browser, type Page } from "playwright";
import type { Document } from "@openconnectors/schemas";

export interface FetchTaxDocumentsParams {
  nationalId: string;
  password: string;
  year: number;
  headless: boolean;
}

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

async function navigateToDocuments(
  _page: Page,
  _year: number
): Promise<void> {
  // Real plugin:
  // await _page.click('a[href*="documents"]');
  // await _page.selectOption('select#yearSelect', String(_year));
  // await _page.click('a.download-annual-report');
  // const download = await _page.waitForEvent('download');
  // await download.saveAs(`/tmp/migdal-statement-${_year}.pdf`);
}

export async function fetchTaxDocuments(
  params: FetchTaxDocumentsParams
): Promise<Document> {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: params.headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    await loginToMigdal(page, params.nationalId, params.password);
    await navigateToDocuments(page, params.year);

    const mockPdfContent = Buffer.from(
      `Migdal Insurance — Annual Pension Statement ${params.year} — ID ${params.nationalId}`
    ).toString("base64");

    const document: Document = {
      id: `MIGDAL-STMT-${params.year}-${params.nationalId.slice(-4)}`,
      title: `Migdal Annual Pension Statement — ${params.year}`,
      type: "investment_statement",
      mimeType: "application/pdf",
      issuedDate: `${params.year + 1}-03-31`,
      taxYear: params.year,
      institution: "Migdal Insurance",
      content: mockPdfContent,
      sizeBytes: mockPdfContent.length,
      metadata: {
        documentType: "annual_pension_report",
        country: "IL",
        nationalId: params.nationalId,
      },
    };

    await context.close();
    return document;
  } finally {
    await browser?.close();
  }
}

/**
 * fetch_tax_documents tool — Harel Insurance & Finance
 *
 * Extracts the annual pension fund statement and related tax documents
 * from the Harel personal portal.
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

async function navigateToDocuments(
  _page: Page,
  _year: number
): Promise<void> {
  // Real plugin:
  // await _page.click('a[href*="documents"]');
  // await _page.selectOption('select#reportYear', String(_year));
  // await _page.click('button#downloadAnnualReport');
  // const download = await _page.waitForEvent('download');
  // await download.saveAs(`/tmp/harel-statement-${_year}.pdf`);
}

export async function fetchTaxDocuments(
  params: FetchTaxDocumentsParams
): Promise<Document> {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: params.headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    await loginToHarel(page, params.nationalId, params.password);
    await navigateToDocuments(page, params.year);

    const mockPdfContent = Buffer.from(
      `Harel Insurance — Annual Pension Statement ${params.year} — ID ${params.nationalId}`
    ).toString("base64");

    const document: Document = {
      id: `HAREL-STMT-${params.year}-${params.nationalId.slice(-4)}`,
      title: `Harel Annual Pension Statement — ${params.year}`,
      type: "investment_statement",
      mimeType: "application/pdf",
      issuedDate: `${params.year + 1}-03-31`,
      taxYear: params.year,
      institution: "Harel Insurance & Finance",
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

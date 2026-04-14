/**
 * fetch_tax_documents tool — Menora Mivtachim
 *
 * Extracts the annual pension fund statement and related tax documents
 * from the Menora Mivtachim personal portal.
 *
 * Real implementation would:
 *   - Navigate to the documents section
 *   - Select the requested tax year
 *   - Download the annual statement PDF (דוח שנתי)
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

async function navigateToDocuments(
  _page: Page,
  _year: number
): Promise<void> {
  // Real plugin:
  // await _page.click('a[href*="documents"]');
  // await _page.selectOption('select#yearSelect', String(_year));
  // await _page.click('button#downloadAnnualReport');
  // const download = await _page.waitForEvent('download');
  // await download.saveAs(`/tmp/menora-statement-${_year}.pdf`);
}

export async function fetchTaxDocuments(
  params: FetchTaxDocumentsParams
): Promise<Document> {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: params.headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    await loginToMenora(page, params.nationalId, params.password);
    await navigateToDocuments(page, params.year);

    const mockPdfContent = Buffer.from(
      `Menora Mivtachim — Annual Pension Statement ${params.year} — ID ${params.nationalId}`
    ).toString("base64");

    const document: Document = {
      id: `MENORA-STMT-${params.year}-${params.nationalId.slice(-4)}`,
      title: `Menora Mivtachim Annual Statement — ${params.year}`,
      type: "investment_statement",
      mimeType: "application/pdf",
      issuedDate: `${params.year + 1}-03-31`,
      taxYear: params.year,
      institution: "Menora Mivtachim",
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

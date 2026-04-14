/**
 * fetch_tax_documents tool — Mizrahi-Tefahot Bank
 *
 * Extracts the annual bank statement and Form 106 (if applicable)
 * from the Mizrahi-Tefahot online banking portal.
 *
 * Real implementation would:
 *   - Navigate to the documents section of the portal
 *   - Select the requested tax year
 *   - Download the annual statement PDF
 *   - Optionally parse structured data from it
 */

import { chromium, type Browser, type Page } from "playwright";
import type { Document, Form106 } from "@openconnectors/schemas";

export interface FetchTaxDocumentsParams {
  nationalId: string;
  password: string;
  year: number;
  headless: boolean;
}

export interface TaxDocumentResult {
  form106: Form106;
  document: Document;
}

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
 * Navigate to the annual tax documents section.
 *
 * Real implementation:
 *   - Click "Documents" or "מסמכים" from the navigation
 *   - Select "Annual Bank Statement" / "דוח שנתי"
 *   - Choose the requested year
 *   - Click "Download PDF"
 *   - Wait for download and read the file
 */
async function navigateToTaxDocuments(
  _page: Page,
  _year: number
): Promise<void> {
  // Real plugin:
  // await _page.click('a[href*="documents"]');
  // await _page.selectOption('select#yearSelect', String(_year));
  // await _page.click('button#downloadStatement');
  // const download = await _page.waitForEvent('download');
  // await download.saveAs(`/tmp/mizrahi-statement-${_year}.pdf`);
}

function generateMockForm106(year: number, nationalId: string): Form106 {
  const gross = 280000 + Math.floor(Math.random() * 60000);

  return {
    taxYear: year,
    employerName: "חברת הייטק ישראל בע\"מ",
    employerTaxId: "512345678",
    employeeName: `לקוח ${nationalId.slice(-4)}`,
    employeeId: nationalId,
    grossSalary: gross,
    taxableIncome: Math.round(gross * 0.87),
    bonusPayments: Math.round(gross * 0.10),
    overtimePayments: 0,
    employeePensionContribution: Math.round(gross * 0.06),
    employerPensionContribution: Math.round(gross * 0.065),
    employeeEducationFund: Math.round(gross * 0.025),
    employerEducationFund: Math.round(gross * 0.075),
    nationalInsurance: Math.round(gross * 0.035),
    healthInsurance: Math.round(gross * 0.031),
    incomeTaxWithheld: Math.round(gross * 0.24),
    taxCreditPoints: 2.25,
  };
}

export async function fetchTaxDocuments(
  params: FetchTaxDocumentsParams
): Promise<TaxDocumentResult> {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: params.headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    await loginToMizrahi(page, params.nationalId, params.password);
    await navigateToTaxDocuments(page, params.year);

    const form106 = generateMockForm106(params.year, params.nationalId);

    const mockPdfContent = Buffer.from(
      `Mizrahi-Tefahot Bank — Annual Statement ${params.year} — ID ${params.nationalId}`
    ).toString("base64");

    const document: Document = {
      id: `MIZRAHI-STMT-${params.year}`,
      title: `Mizrahi-Tefahot Annual Statement — ${params.year}`,
      type: "bank_statement",
      mimeType: "application/pdf",
      issuedDate: `${params.year + 1}-02-28`,
      taxYear: params.year,
      institution: "Mizrahi-Tefahot Bank",
      content: mockPdfContent,
      sizeBytes: mockPdfContent.length,
      metadata: {
        formType: "annual_statement",
        country: "IL",
        nationalId: params.nationalId,
      },
    };

    await context.close();
    return { form106, document };
  } finally {
    await browser?.close();
  }
}

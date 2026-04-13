/**
 * fetch_tax_documents tool implementation
 *
 * Demonstrates extracting tax documents (Form 106) from a bank portal.
 * In a real plugin, Playwright would navigate to the documents section,
 * download the PDF, and parse structured data from it.
 *
 * This mock returns a realistic Form 106 and a Document metadata entry.
 */

import { chromium, type Browser, type Page } from "playwright";
import type { Document, Form106 } from "@openconnectors/schemas";

export interface FetchTaxDocumentsParams {
  username: string;
  password: string;
  year: number;
  headless: boolean;
}

interface TaxDocumentResult {
  form106: Form106;
  document: Document;
}

/** Simulated login — same pattern as fetch-transactions. */
async function loginToBank(
  page: Page,
  username: string,
  _password: string
): Promise<void> {
  await page.goto("about:blank");
  await page.evaluate(
    (user) => {
      document.title = `Mock Bank Documents - ${user}`;
    },
    username
  );
}

/** Generate a realistic mock Form 106 for the given year. */
function generateMockForm106(year: number, employeeName: string): Form106 {
  const gross = 264000 + Math.floor(Math.random() * 36000);

  return {
    taxYear: year,
    employerName: "TechCo Israel Ltd",
    employerTaxId: "514123456",
    employeeName,
    employeeId: "012345678",
    grossSalary: gross,
    taxableIncome: Math.round(gross * 0.85),
    bonusPayments: Math.round(gross * 0.08),
    overtimePayments: 0,
    employeePensionContribution: Math.round(gross * 0.06),
    employerPensionContribution: Math.round(gross * 0.065),
    employeeEducationFund: Math.round(gross * 0.025),
    employerEducationFund: Math.round(gross * 0.075),
    nationalInsurance: Math.round(gross * 0.035),
    healthInsurance: Math.round(gross * 0.031),
    incomeTaxWithheld: Math.round(gross * 0.22),
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

    await loginToBank(page, params.username, params.password);

    // In a real plugin: navigate to tax documents section, click download,
    // wait for PDF, read it from disk, optionally parse with a PDF library.

    const form106 = generateMockForm106(params.year, params.username);

    // Simulate a document entry (in reality, this would be the downloaded PDF)
    const mockPdfContent = Buffer.from(
      `Mock Form 106 PDF for ${params.year} — ${params.username}`
    ).toString("base64");

    const document: Document = {
      id: `MOCK-106-${params.year}`,
      title: `Form 106 — Tax Year ${params.year}`,
      type: "tax_form",
      mimeType: "application/pdf",
      issuedDate: `${params.year + 1}-03-15`,
      taxYear: params.year,
      institution: "Mock Bank Ltd",
      content: mockPdfContent,
      sizeBytes: mockPdfContent.length,
      metadata: {
        formType: "106",
        country: "IL",
      },
    };

    await context.close();
    return { form106, document };
  } finally {
    await browser?.close();
  }
}

/**
 * Israeli Form 106 (Tofes 106) Schema and IRS Mapping
 *
 * Form 106 is the annual employer tax certificate in Israel, similar
 * in purpose to the US W-2. This module defines:
 *
 *   1. A normalized schema for parsed Form 106 data.
 *   2. A mapping table from Form 106 fields → IRS form fields,
 *      enabling cross-border tax preparation.
 *
 * Note: Amounts in the Form 106 are in ILS. Conversion to USD is
 * left to downstream consumer apps using the appropriate exchange rate.
 */

import { z } from "zod";

export const Form106Schema = z.object({
  /** Tax year this form covers. */
  taxYear: z.number().int().min(2000).max(2100),

  /** Employer name (Hebrew or English). */
  employerName: z.string().min(1),

  /** Employer tax file number (Tik Nikuyim). */
  employerTaxId: z.string().min(1),

  /** Employee name. */
  employeeName: z.string().min(1),

  /** Employee ID number (Teudat Zehut). */
  employeeId: z.string().min(1),

  // --- Income fields ---

  /** Box 172: Gross salary before any deductions. */
  grossSalary: z.number(),

  /** Box 042: Taxable income after exemptions. */
  taxableIncome: z.number(),

  /** Box 218: Bonus and special payments. */
  bonusPayments: z.number().default(0),

  /** Box 036: Overtime payments. */
  overtimePayments: z.number().default(0),

  // --- Deductions and contributions ---

  /** Box 086: Employee pension contributions. */
  employeePensionContribution: z.number().default(0),

  /** Box 090: Employer pension contributions. */
  employerPensionContribution: z.number().default(0),

  /** Box 094: Employee education fund (Keren Hishtalmut). */
  employeeEducationFund: z.number().default(0),

  /** Box 098: Employer education fund. */
  employerEducationFund: z.number().default(0),

  /** Box 045: National Insurance (Bituach Leumi) — employee share. */
  nationalInsurance: z.number().default(0),

  /** Box 047: Health Insurance (Bituach Briut) — employee share. */
  healthInsurance: z.number().default(0),

  // --- Taxes withheld ---

  /** Box 043: Income tax withheld at source. */
  incomeTaxWithheld: z.number(),

  /** Tax credit points (Nekudot Zikuy) applied. */
  taxCreditPoints: z.number().default(0),

  /** Plugin-specific metadata. */
  metadata: z.record(z.unknown()).optional(),
});

export type Form106 = z.infer<typeof Form106Schema>;

/**
 * Mapping from Israeli Form 106 fields to IRS form fields.
 *
 * When a US-Israel dual filer prepares taxes, these mappings indicate
 * where each Form 106 value should be reported on US tax forms.
 * Foreign currency conversion and FEIE/FTC elections are handled
 * by the consumer app — this table only maps the semantics.
 */
export interface Form106FieldMapping {
  /** Form 106 field name (matching Form106 schema keys). */
  form106Field: keyof Form106;
  /** Target IRS form (e.g. "1040", "2555", "1116"). */
  irsForm: string;
  /** IRS form line/box number. */
  irsLine: string;
  /** Human-readable description of the mapping. */
  description: string;
  /** Notes about conversion or special handling. */
  notes?: string;
}

/**
 * Reference mapping table: Form 106 → IRS.
 *
 * This covers the most common fields. Tax professionals should
 * verify mappings for their specific filing situation.
 */
export const Form106ToIRSMapping: Form106FieldMapping[] = [
  {
    form106Field: "grossSalary",
    irsForm: "1040",
    irsLine: "1",
    description: "Wages, salaries, tips (converted to USD)",
    notes: "Convert ILS to USD using IRS annual average exchange rate",
  },
  {
    form106Field: "grossSalary",
    irsForm: "2555",
    irsLine: "19",
    description: "Foreign earned income (for FEIE election)",
    notes: "Only if electing Foreign Earned Income Exclusion",
  },
  {
    form106Field: "incomeTaxWithheld",
    irsForm: "1116",
    irsLine: "8",
    description: "Foreign taxes paid or accrued — income tax",
    notes: "For Foreign Tax Credit election; convert to USD at rate when paid",
  },
  {
    form106Field: "nationalInsurance",
    irsForm: "1116",
    irsLine: "8",
    description: "Foreign taxes paid or accrued — social security (Bituach Leumi)",
    notes: "Treated as foreign tax for FTC purposes per US-Israel tax treaty",
  },
  {
    form106Field: "healthInsurance",
    irsForm: "1116",
    irsLine: "8",
    description: "Foreign taxes paid or accrued — health insurance (Bituach Briut)",
    notes: "Treated as foreign tax for FTC; not deductible as medical expense",
  },
  {
    form106Field: "employeePensionContribution",
    irsForm: "1040",
    irsLine: "20a",
    description: "IRA deduction / foreign pension contribution",
    notes: "Treatment depends on US-Israel treaty pension article; consult CPA",
  },
  {
    form106Field: "employeeEducationFund",
    irsForm: "1040",
    irsLine: "1",
    description:
      "Education fund contributions are part of compensation",
    notes:
      "Employer portion may be tax-deferred under treaty; employee portion is taxable",
  },
  {
    form106Field: "bonusPayments",
    irsForm: "1040",
    irsLine: "1",
    description: "Included in wages — supplemental compensation",
    notes: "Already included in gross salary box; listed separately for tracking",
  },
  {
    form106Field: "taxCreditPoints",
    irsForm: "1116",
    irsLine: "12",
    description: "Reduces Israeli tax liability, affects FTC calculation",
    notes:
      "The IRS FTC is based on tax actually paid, so credit points reduce the available credit",
  },
];

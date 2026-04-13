/**
 * Normalized Document Schema
 *
 * Represents a document retrieved from an institution — tax forms,
 * statements, receipts, medical records, government letters, etc.
 */

import { z } from "zod";

/** Standard document types. */
export const DocumentType = {
  TAX_FORM: "tax_form",
  BANK_STATEMENT: "bank_statement",
  CREDIT_CARD_STATEMENT: "credit_card_statement",
  INVESTMENT_STATEMENT: "investment_statement",
  PAY_STUB: "pay_stub",
  RECEIPT: "receipt",
  INSURANCE_POLICY: "insurance_policy",
  MEDICAL_RECORD: "medical_record",
  GOVERNMENT_LETTER: "government_letter",
  IDENTITY_DOCUMENT: "identity_document",
  OTHER: "other",
} as const;

export const DocumentSchema = z.object({
  /** Unique document identifier. */
  id: z.string().min(1),

  /** Document title or filename. */
  title: z.string().min(1),

  /** Normalized document type. */
  type: z.nativeEnum(
    Object.fromEntries(
      Object.entries(DocumentType).map(([k, v]) => [k, v])
    ) as { [K in keyof typeof DocumentType]: (typeof DocumentType)[K] }
  ),

  /** MIME type (e.g. "application/pdf", "image/png"). */
  mimeType: z.string(),

  /** ISO 8601 date the document was issued. */
  issuedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

  /** Fiscal/tax year the document pertains to. */
  taxYear: z.number().int().min(1900).max(2100).optional(),

  /** Institution that issued the document. */
  institution: z.string().optional(),

  /**
   * The raw document content as a base64-encoded string.
   * Large documents may use a file:// URI pointing to a local path instead.
   */
  content: z.string(),

  /** File size in bytes, if known. */
  sizeBytes: z.number().int().positive().optional(),

  /** SHA-256 hash of the raw content for integrity verification. */
  sha256: z.string().optional(),

  /** Plugin-specific metadata. */
  metadata: z.record(z.unknown()).optional(),
});

export type Document = z.infer<typeof DocumentSchema>;

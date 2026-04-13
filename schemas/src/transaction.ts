/**
 * Normalized Transaction Schema
 *
 * A universal representation of a financial transaction that works
 * across banks, credit cards, and investment accounts worldwide.
 */

import { z } from "zod";

/** Standard transaction categories. Plugins map institution-specific labels to these. */
export const TransactionCategory = {
  INCOME: "income",
  HOUSING: "housing",
  TRANSPORTATION: "transportation",
  FOOD: "food",
  UTILITIES: "utilities",
  HEALTHCARE: "healthcare",
  INSURANCE: "insurance",
  ENTERTAINMENT: "entertainment",
  SHOPPING: "shopping",
  EDUCATION: "education",
  SAVINGS: "savings",
  INVESTMENT: "investment",
  TRANSFER: "transfer",
  FEE: "fee",
  TAX: "tax",
  OTHER: "other",
} as const;

export const TransactionSchema = z.object({
  /** Unique identifier from the source institution. */
  id: z.string().min(1),

  /** ISO 8601 date string (YYYY-MM-DD) of the transaction. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),

  /** Transaction amount. Negative = debit, positive = credit. */
  amount: z.number(),

  /** ISO 4217 currency code (e.g. "USD", "ILS", "EUR"). */
  currency: z.string().length(3),

  /** Description from the institution (may be raw/ugly). */
  originalDescription: z.string(),

  /** Cleaned/normalized description for display. */
  description: z.string(),

  /** Normalized category. */
  category: z.nativeEnum(
    Object.fromEntries(
      Object.entries(TransactionCategory).map(([k, v]) => [k, v])
    ) as { [K in keyof typeof TransactionCategory]: (typeof TransactionCategory)[K] }
  ).optional(),

  /** Account identifier at the institution. */
  accountId: z.string().optional(),

  /** Running balance after this transaction, if available. */
  balance: z.number().optional(),

  /** ISO 8601 date of when the transaction posted (vs. initiated). */
  postedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

  /** Whether the transaction is still pending. */
  pending: z.boolean().default(false),

  /** Plugin-specific metadata for extensibility. */
  metadata: z.record(z.unknown()).optional(),
});

export type Transaction = z.infer<typeof TransactionSchema>;

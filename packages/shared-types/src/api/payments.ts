import { z } from "zod";
import { CURRENCY_CODES, PAYMENT_STATUSES, type CurrencyCode, type PaymentStatus } from "../enums";

/**
 * payment-engine (Session 13, RFP #9): initiate a fee payment against IIPS
 * via pm4ml. Every mutating call here MUST carry the shared Idempotency-Key
 * header (see api/common.ts) — IIPS has documented transaction-failure
 * history (Jan-Feb 2026), so a missed idempotency key is the exact failure
 * mode that would double-credit a citizen's payment.
 */
export interface InitiatePaymentRequest {
  citizenId: string;
  documentId: string | null; // null for payments not tied to a specific document (e.g. renewal fee pre-approval)
  amount: number;
  /** Liberia runs a de facto dual-currency economy — LRD (legal tender) or USD (routinely used for government fees). */
  currency: CurrencyCode;
  /** Which mobile-money rail IIPS should route to. IIPS itself picks the underlying provider (Lonestar Cell MTN or Orange Money). */
  paymentMethod: "mobile_money" | "bank_transfer";
}

export const InitiatePaymentRequestSchema = z.object({
  citizenId: z.string().uuid(),
  documentId: z.string().uuid().nullable(),
  amount: z.number().positive(),
  currency: z.enum(CURRENCY_CODES),
  paymentMethod: z.enum(["mobile_money", "bank_transfer"]),
});

export interface InitiatePaymentResponse {
  paymentId: string;
  status: PaymentStatus;
  /** IIPS/pm4ml's own transaction reference, once assigned. Null while still `pending`. */
  iipsTransactionRef: string | null;
}

export const InitiatePaymentResponseSchema = z.object({
  paymentId: z.string().uuid(),
  status: z.enum(PAYMENT_STATUSES),
  iipsTransactionRef: z.string().nullable(),
});

/** A digital receipt — issued once a payment reaches `completed`. */
export interface PaymentReceipt {
  paymentId: string;
  citizenId: string;
  amount: number;
  currency: CurrencyCode;
  iipsTransactionRef: string;
  completedAt: string; // ISO 8601
  receiptNumber: string; // human-readable, e.g. "RCPT-2026-000123"
}

export const PaymentReceiptSchema = z.object({
  paymentId: z.string().uuid(),
  citizenId: z.string().uuid(),
  amount: z.number().positive(),
  currency: z.enum(CURRENCY_CODES),
  iipsTransactionRef: z.string().min(1),
  completedAt: z.string().datetime(),
  receiptNumber: z.string().min(1),
});

/**
 * Reconciliation-job result shape (payment-engine, per Phase 0/2's idempotency +
 * reconciliation decision) — reports on dropped/duplicated transactions found
 * when reconciling against IIPS, given IIPS's documented reliability issues.
 */
export interface ReconciliationRunResult {
  runId: string;
  startedAt: string;
  completedAt: string;
  transactionsChecked: number;
  discrepanciesFound: number;
  duplicatesResolved: number;
  missingConfirmationsResolved: number;
}

export const ReconciliationRunResultSchema = z.object({
  runId: z.string().uuid(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  transactionsChecked: z.number().int().nonnegative(),
  discrepanciesFound: z.number().int().nonnegative(),
  duplicatesResolved: z.number().int().nonnegative(),
  missingConfirmationsResolved: z.number().int().nonnegative(),
});

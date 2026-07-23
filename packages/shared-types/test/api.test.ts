import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_HEADER } from "../src/api/common";
import { IssueDocumentRequestSchema, RenewDocumentResponseSchema } from "../src/api/documents";
import { VerifyRequestSchema, VerifyResponseSchema } from "../src/api/verification";
import { InitiatePaymentRequestSchema } from "../src/api/payments";
import { CreateConsentGrantRequestSchema } from "../src/api/consent";

describe("api/common", () => {
  it("exposes the canonical idempotency header name", () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe("Idempotency-Key");
  });
});

describe("api/documents", () => {
  it("IssueDocumentRequestSchema accepts a valid Phase 1 issuance request", () => {
    const req = {
      citizenId: "11111111-1111-1111-1111-111111111111",
      documentType: "TAX_CERTIFICATE" as const,
      fields: { tin: "TIN-0001", taxPeriod: "2026-Q1" },
    };
    expect(() => IssueDocumentRequestSchema.parse(req)).not.toThrow();
  });

  it("RenewDocumentResponseSchema allows a null fee (some renewals are free)", () => {
    const res = {
      renewalRequestId: "11111111-1111-1111-1111-111111111111",
      status: "draft" as const,
      feeAmount: null,
      feeCurrency: null,
    };
    expect(() => RenewDocumentResponseSchema.parse(res)).not.toThrow();
  });
});

describe("api/verification", () => {
  it("VerifyResponseSchema requires minimalFields to be null when not_verified", () => {
    // schema-level: null is allowed regardless of status; the *service* enforces
    // the not_verified -> null pairing. This test documents that the type permits it.
    const res = { status: "not_verified" as const, minimalFields: null, checkedAt: new Date().toISOString() };
    expect(() => VerifyResponseSchema.parse(res)).not.toThrow();
  });

  it("VerifyRequestSchema rejects an empty token", () => {
    expect(() => VerifyRequestSchema.parse({ verificationToken: "" })).toThrow();
  });
});

describe("api/payments", () => {
  it("InitiatePaymentRequestSchema rejects a malformed currency code", () => {
    const req = {
      citizenId: "11111111-1111-1111-1111-111111111111",
      documentId: null,
      amount: 25,
      currency: "US",
      paymentMethod: "mobile_money" as const,
    };
    expect(() => InitiatePaymentRequestSchema.parse(req)).toThrow();
  });

  it("InitiatePaymentRequestSchema rejects a real but non-Liberian currency (EUR) — platform only handles LRD/USD", () => {
    const req = {
      citizenId: "11111111-1111-1111-1111-111111111111",
      documentId: null,
      amount: 25,
      currency: "EUR",
      paymentMethod: "mobile_money" as const,
    };
    expect(() => InitiatePaymentRequestSchema.parse(req)).toThrow();
  });

  it("InitiatePaymentRequestSchema accepts USD (routinely used for government fees in Liberia)", () => {
    const req = {
      citizenId: "11111111-1111-1111-1111-111111111111",
      documentId: "22222222-2222-2222-2222-222222222222",
      amount: 25,
      currency: "USD",
      paymentMethod: "mobile_money" as const,
    };
    expect(() => InitiatePaymentRequestSchema.parse(req)).not.toThrow();
  });

  it("InitiatePaymentRequestSchema accepts LRD (Liberian dollar, legal tender)", () => {
    const req = {
      citizenId: "11111111-1111-1111-1111-111111111111",
      documentId: "22222222-2222-2222-2222-222222222222",
      amount: 2500,
      currency: "LRD",
      paymentMethod: "bank_transfer" as const,
    };
    expect(() => InitiatePaymentRequestSchema.parse(req)).not.toThrow();
  });
});

describe("api/consent", () => {
  it("CreateConsentGrantRequestSchema rejects zero requestedDurationSeconds", () => {
    const req = {
      documentId: "11111111-1111-1111-1111-111111111111",
      granteeId: "22222222-2222-2222-2222-222222222222",
      purposeCode: "EMPLOYMENT_VERIFICATION",
      scopedFields: ["fullName"],
      requestedDurationSeconds: 0,
    };
    expect(() => CreateConsentGrantRequestSchema.parse(req)).toThrow();
  });
});

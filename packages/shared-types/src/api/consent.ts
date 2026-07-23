import { z } from "zod";

/** consent-engine (Session 9): request a new grant. Always starts in `pending_otp`. */
export interface CreateConsentGrantRequest {
  documentId: string;
  granteeId: string;
  purposeCode: string;
  scopedFields: string[];
  /** Requested lifetime in seconds; consent-engine may cap this. */
  requestedDurationSeconds: number;
}

export const CreateConsentGrantRequestSchema = z.object({
  documentId: z.string().uuid(),
  granteeId: z.string().uuid(),
  purposeCode: z.string().min(1),
  scopedFields: z.array(z.string().min(1)).min(1),
  requestedDurationSeconds: z.number().int().positive(),
});

export interface CreateConsentGrantResponse {
  grantId: string;
  state: "pending_otp";
  /** Where the OTP was sent — never the OTP itself. */
  otpChannel: "sms" | "app_push";
}

export const CreateConsentGrantResponseSchema = z.object({
  grantId: z.string().uuid(),
  state: z.literal("pending_otp"),
  otpChannel: z.enum(["sms", "app_push"]),
});

/** Confirm the OTP sent for a pending grant — transitions pending_otp -> active. */
export interface ConfirmConsentGrantOtpRequest {
  grantId: string;
  otpCode: string;
}

export const ConfirmConsentGrantOtpRequestSchema = z.object({
  grantId: z.string().uuid(),
  otpCode: z.string().min(4).max(8),
});

/** citizen-locker-api (Session 18): `POST /me/consent-grants/:id/revoke`. Always instant, never cached. */
export interface RevokeConsentGrantRequest {
  grantId: string;
}

export const RevokeConsentGrantRequestSchema = z.object({
  grantId: z.string().uuid(),
});

export interface RevokeConsentGrantResponse {
  grantId: string;
  state: "revoked";
  revokedAt: string; // ISO 8601
}

export const RevokeConsentGrantResponseSchema = z.object({
  grantId: z.string().uuid(),
  state: z.literal("revoked"),
  revokedAt: z.string().datetime(),
});

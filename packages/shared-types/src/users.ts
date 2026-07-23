import { z } from "zod";
import { ROLES, USER_TYPES, type Role, type UserType } from "./enums";

/**
 * Liberia's own E.164 country code is +231. Lonestar Cell MTN and Orange
 * Liberia between them hold >90% of subscriptions (per the blueprint's
 * USSD/notifications research) — every real phone number on this platform
 * is a Liberian mobile number, not an arbitrary international one, so the
 * validation is scoped to +231 rather than a generic phone-format check.
 * Subscriber-number length varies slightly by network/vintage, so 8-9 digits
 * after the country code is accepted.
 */
export const LIBERIA_PHONE_REGEX = /^\+231\d{8,9}$/;

/** Mirrors the `users` table (migration 002) — covers all 4 user_types. */
export interface User {
  id: string; // UUID
  userType: UserType;
  fullName: string;
  /**
   * Present for CITIZEN accounts backed by NIR (or the passport/voter-ID fallback
   * path, per Phase 1's auth fallback requirement) — null for agency staff/admin
   * accounts that authenticate via agency SSO instead.
   */
  nationalIdNumber: string | null;
  /** Null for CITIZEN and PLATFORM_ADMIN accounts; required for AGENCY_STAFF/AGENCY_SUPERVISOR. */
  agencyId: string | null; // UUID, FK -> agencies.id
  phoneNumber: string | null;
  email: string | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export const UserSchema = z.object({
  id: z.string().uuid(),
  userType: z.enum(USER_TYPES),
  fullName: z.string().min(1),
  nationalIdNumber: z.string().nullable(),
  agencyId: z.string().uuid().nullable(),
  phoneNumber: z
    .string()
    .regex(LIBERIA_PHONE_REGEX, "expected a Liberian mobile number in +231 E.164 format")
    .nullable(),
  email: z.string().email().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** Mirrors the `user_roles` ABAC join table — a user's role is always scoped to one agency. */
export interface UserRoleGrant {
  id: string; // UUID
  userId: string; // UUID
  role: Role;
  agencyId: string; // UUID — scope of this role grant (RBAC + ABAC per Phase 1)
  grantedAt: string; // ISO 8601
  grantedBy: string; // UUID of the granting user
}

export const UserRoleGrantSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.enum(ROLES),
  agencyId: z.string().uuid(),
  grantedAt: z.string().datetime(),
  grantedBy: z.string().uuid(),
});

/**
 * Separation-of-duties check (Phase 1 test gate): a role-conflict attempt
 * (same user issuing and approving within the same agency) must be rejected.
 * This is the shared predicate every service enforcing that rule should call,
 * so the rule is defined once, not reimplemented per service.
 */
export function violatesSeparationOfDuties(
  existingGrants: readonly Pick<UserRoleGrant, "role" | "agencyId">[],
  incoming: Pick<UserRoleGrant, "role" | "agencyId">,
): boolean {
  const conflictSet: readonly Role[] = ["ISSUER", "APPROVER", "AUDITOR"];
  if (!conflictSet.includes(incoming.role)) return false;

  return existingGrants.some(
    (g) =>
      g.agencyId === incoming.agencyId &&
      conflictSet.includes(g.role) &&
      g.role !== incoming.role,
  );
}

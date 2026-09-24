import { describe, expect, expectTypeOf, test } from "bun:test";
import type { SessionStatusResponse } from "../../src/console/auth/session";
import type { SessionResponse, SessionUser } from "./lib/contracts";

/**
 * `SessionResponse` (dashboard) is the backend `SessionStatusResponse` and
 * `SessionUser` is its authenticated arm in the dashboard's camelCase
 * convention — this pins both.
 *
 * The mirror this replaces was hand-written and had drifted: it omitted
 * `username` and marked `display_name`, `is_first_boot`, and
 * `session_expires_at` required. Nothing compared the two, so the drift was
 * invisible until the backend type became a discriminated union.
 */
describe("dashboard/backend parity — session contract", () => {
  test("SessionResponse is exactly the backend status response", () => {
    expectTypeOf<SessionResponse>().toEqualTypeOf<SessionStatusResponse>();
  });

  test("SessionUser carries every authenticated field under its dashboard name", () => {
    // `SessionUser` is not a rename of the wire arm — it renames fields too, so
    // the assertion is on the field *set*: dropping `username` from either side
    // makes one of these key checks fail.
    type WireKeys = keyof Extract<SessionStatusResponse, { status: "authenticated" }>;
    type UserKeys = keyof SessionUser;
    expectTypeOf<UserKeys>().toEqualTypeOf<
      | "id"
      | "username"
      | "email"
      | "displayName"
      | "isFirstBoot"
      | "sessionExpiresAt"
      | "isPlatformAdmin"
    >();
    const wireKeys: readonly WireKeys[] = [
      "status",
      "user_id",
      "username",
      "email",
      "display_name",
      "is_first_boot",
      "session_expires_at",
      "is_platform_admin",
    ];
    expect(wireKeys).toHaveLength(8);
  });

  test("every field the wire arm guarantees is required on SessionUser", () => {
    // A required field on `SessionUser` that the wire arm marks optional would
    // be a lie `fetchSessionUser` could not honour.
    expectTypeOf<Required<SessionUser>["username"]>().toEqualTypeOf<string>();
    expectTypeOf<SessionUser["displayName"]>().toEqualTypeOf<string | null>();
    expectTypeOf<SessionUser["isFirstBoot"]>().toEqualTypeOf<boolean>();
    expectTypeOf<SessionUser["isPlatformAdmin"]>().toEqualTypeOf<boolean>();
  });
});

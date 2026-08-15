import { describe, expect, test } from "vitest";

import { accountIdentity } from "../../../src/features/providers/formatters";

describe("accountIdentity", () => {
  test("puts email first and keeps the username or name beneath it", () => {
    expect(accountIdentity("Cursor 1", "risundaily@gmail.com")).toEqual({
      primary: "risundaily@gmail.com",
      secondary: "Cursor 1",
    });
    expect(accountIdentity("risundaily@gmail.com", "username")).toEqual({
      primary: "risundaily@gmail.com",
      secondary: "username",
    });
  });

  test("falls back to the provider username or name when no email exists", () => {
    expect(accountIdentity("Cursor 1", "Cursor 1")).toEqual({
      primary: "Cursor 1",
      secondary: null,
    });
    expect(accountIdentity("eyJopaque-token", "cursor-account")).toEqual({
      primary: "cursor-account",
      secondary: null,
    });
  });
});

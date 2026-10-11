import { describe, expect, test } from "bun:test";
import { resolveDevAdminCredentials } from "../../scripts/dev/console-auth";

/**
 * The fail-closed half of `bun run dev:console-auth`.
 *
 * This is the assertion that keeps the dev console sign-in a
 * credential-from-the-environment tool. If it ever grew a prompt, a default
 * password, or a silent empty-string password, the command would "work" against
 * the wrong account — or against no account — and a later reader would mistake
 * the result for a real sign-in. `AGENTS.md` requires credentials to come from
 * the environment, never from a message, and never invented.
 */
describe("resolveDevAdminCredentials", () => {
  const withEnv = (
    values: { readonly user?: string; readonly password?: string },
    run: () => void,
  ): void => {
    const previous = {
      user: process.env.CARTETHYIA_DEV_ADMIN_USER,
      password: process.env.CARTETHYIA_DEV_ADMIN_PASSWORD,
    };
    delete process.env.CARTETHYIA_DEV_ADMIN_USER;
    delete process.env.CARTETHYIA_DEV_ADMIN_PASSWORD;
    if (values.user !== undefined) process.env.CARTETHYIA_DEV_ADMIN_USER = values.user;
    if (values.password !== undefined) process.env.CARTETHYIA_DEV_ADMIN_PASSWORD = values.password;
    try {
      run();
    } finally {
      process.env.CARTETHYIA_DEV_ADMIN_USER = previous.user;
      process.env.CARTETHYIA_DEV_ADMIN_PASSWORD = previous.password;
    }
  };

  test("an unset password is refused, and the error names the variable", () => {
    withEnv({ user: "admin" }, () => {
      // Naming the variable is the whole point: the operator should fix the
      // environment, not guess what the tool wanted.
      expect(() => resolveDevAdminCredentials()).toThrow(/CARTETHYIA_DEV_ADMIN_PASSWORD/);
    });
  });

  test("a blank password is refused too, not treated as a value", () => {
    withEnv({ user: "admin", password: "   " }, () => {
      // A whitespace password would otherwise reach the sign-in form and come
      // back as an auth failure that reads like a broken console.
      expect(() => resolveDevAdminCredentials()).toThrow(/CARTETHYIA_DEV_ADMIN_PASSWORD/);
    });
  });

  test("an unset user defaults to admin", () => {
    withEnv({ password: "from-the-environment" }, () => {
      // The setup wizard and the console both create/expect `admin`, so
      // defaulting it is convenience; defaulting the password is not.
      expect(resolveDevAdminCredentials()).toEqual({
        user: "admin",
        password: "from-the-environment",
      });
    });
  });

  test("both values come from the environment verbatim", () => {
    withEnv({ user: "operator", password: "from-the-environment" }, () => {
      expect(resolveDevAdminCredentials()).toEqual({
        user: "operator",
        password: "from-the-environment",
      });
    });
  });

  test("surrounding whitespace is trimmed before it reaches the form", () => {
    withEnv({ user: " operator\n", password: " from-the-environment\n" }, () => {
      // A trailing newline is what a pasted `.env` line actually carries, and it
      // would be sent as part of the credential.
      expect(resolveDevAdminCredentials()).toEqual({
        user: "operator",
        password: "from-the-environment",
      });
    });
  });
});

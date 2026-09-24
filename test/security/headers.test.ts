import { describe, expect, test } from "bun:test";
import {
  API_CONTENT_SECURITY_POLICY,
  X_FRAME_OPTIONS,
  dashboardContentSecurityPolicy,
  inlineScriptBodies,
  inlineScriptHash,
} from "../../src/security/outbound-headers";

describe("security header policy", () => {
  test("API CSP denies every resource class and blocks framing", () => {
    expect(API_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(API_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(API_CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(X_FRAME_OPTIONS).toBe("DENY");
  });

  test("inlineScriptHash is a stable base64 sha256 source expression", () => {
    const hash = inlineScriptHash("console.log(1)");
    expect(hash).toMatch(/^'sha256-[A-Za-z0-9+/=]+'$/);
    expect(inlineScriptHash("console.log(1)")).toBe(hash);
    expect(inlineScriptHash("console.log(2)")).not.toBe(hash);
  });

  test("inlineScriptBodies extracts only scripts without a src attribute", () => {
    const html = [
      `<script src="/app.js"></script>`,
      `<script>theme()</script>`,
      `<script type="module" src="/main.js"></script>`,
      `<script>\n  boot()\n</script>`,
      `<script>   </script>`,
    ].join("");
    expect(inlineScriptBodies(html)).toEqual(["theme()", "\n  boot()\n"]);
  });

  test("dashboard CSP allows only hashed inline scripts", () => {
    const csp = dashboardContentSecurityPolicy("<script>boot()</script>");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain(inlineScriptHash("boot()"));
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("https://fonts.gstatic.com");
  });

  test("dashboard CSP omits hashes when no inline script exists", () => {
    const csp = dashboardContentSecurityPolicy("<html><body></body></html>");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'sha256-");
  });
});

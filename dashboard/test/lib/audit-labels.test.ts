import { describe, expect, test } from "bun:test";
import { auditActionLabel, prettifyAuditAction } from "../../src/lib/audit-labels";

describe("audit action labels", () => {
  test("known backend actions have explicit human labels", () => {
    expect(auditActionLabel("provider.updated")).toBe("Provider updated");
    expect(auditActionLabel("provider_account.circuit_force_closed")).toBe(
      "Provider account circuit force-closed",
    );
    expect(auditActionLabel("provider_account.exported")).toBe(
      "Provider accounts exported (plaintext)",
    );
    expect(auditActionLabel("api_key.revoked")).toBe("API key revoked");
    expect(auditActionLabel("security.ip_banned")).toBe("IP banned");
    expect(auditActionLabel("console_logs.cleared")).toBe("Console logs cleared");
  });

  test("unknown actions fall back to a readable prettifier", () => {
    expect(prettifyAuditAction("something.brand_new")).toBe("Something · Brand New");
    expect(auditActionLabel("api_key.rotated")).toBe("API Key · Rotated");
    expect(auditActionLabel("")).toBe("");
  });
});

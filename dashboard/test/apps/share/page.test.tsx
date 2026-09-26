import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShareEnrollmentData } from "../../../src/lib/hooks/share-data";

(globalThis as { window?: unknown }).window = {
  location: { pathname: "/share/public-token", origin: "https://gateway.example" },
  localStorage: { getItem: () => null, setItem: () => undefined },
};

interface ShareState { data: ShareEnrollmentData | null; error: string | null; loading: boolean }
let shareState: ShareState = { data: null, error: null, loading: true };
mock.module("../../../src/lib/hooks/share-data", () => ({ useShareData: (): ShareState => shareState }));
// Load after mock.module so the page captures the mocked data hook.
const { SharePage, tokenFromPathname } = await import("../../../src/apps/share/page");
function render(): string { return renderToStaticMarkup(createElement(SharePage)); }

const data: ShareEnrollmentData = {
  name: "Team Access", keyPrefix: "ctk", canIssue: true, alreadyIssued: false,
  dailyLimit: 50_000, monthlyLimit: null, oneTimeLimit: null, requestsPerMinute: 20,
  maxConcurrentRequests: 3, providerAllowlist: ["openai"], modelAllowlist: ["gpt-5"],
  modelDenylist: null, modelPrefix: "gpt-", notes: { title: null, subtitle: "Shared access", body: "Use responsibly" },
  expiresAt: null,
};

describe("public share enrollment page", () => {
  test("shows a loading state while enrollment policy is fetched", () => {
    shareState = { data: null, error: null, loading: true };
    const markup = render();
    expect(markup).toContain("Loading enrollment policy…");
    expect(markup).not.toContain("Generate API Key");
  });

  test("offers the public endpoint and key generation action", () => {
    shareState = { data, error: null, loading: false };
    const markup = render();
    // The recipient is told to call the origin they reached this page by.
    expect(markup).toContain("https://gateway.example/v1");
    expect(markup).toContain("Base URL");
    expect(markup).toContain("Generate API Key");
  });

  test("shows policy and explicit child-key generation without disclosing any credential", () => {
    shareState = { data, error: null, loading: false };
    const markup = render();
    expect(markup).toContain("Team Access");
    expect(markup).toContain("Generate API Key");
    expect(markup).toContain("never displays a parent credential");
    expect(markup).toContain("Allowed models");
    expect(markup).toContain("gpt-5");
    expect(markup).toContain("Required model prefix: gpt-");
    expect(markup).not.toContain("parentSecret");
    expect(markup).not.toContain("sk-parent-raw");
    expect(markup).not.toContain("telemetry");
  });

  test("does not offer another generation after this IP has already enrolled", () => {
    shareState = { data: { ...data, canIssue: false, alreadyIssued: true }, error: null, loading: false };
    const markup = render();
    expect(markup).toContain("An active key has already been issued from this IP.");
    expect(markup).not.toContain("Generate API Key");
  });

  test("shows a useful unavailable state", () => {
    shareState = { data: null, error: "This enrollment link has expired.", loading: false };
    expect(render()).toContain("This enrollment link has expired.");
  });

  test("extracts the enrollment token from the pathname", () => {
    expect(tokenFromPathname("/share/public-token/")).toBe("public-token");
    expect(tokenFromPathname("/share/public-token")).toBe("public-token");
  });
});

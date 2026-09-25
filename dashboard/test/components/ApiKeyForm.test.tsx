import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiKeyForm, keyCredentialFields, oneTimeSecretForMode } from "../../src/components/ApiKeyForm";
import type { ApiKeyResponse } from "../../src/lib/contracts";

const shareRecord: ApiKeyResponse = {
  id: "parent-id", label: "Team share", keyMode: "share", scopes: [], createdAt: "2026-09-01T00:00:00.000Z", tokensConsumed: 0,
};
function render(mode: "create" | "edit", record: ApiKeyResponse | null): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ApiKeyForm, {
        mode,
        record,
        busy: false,
        onDone: () => undefined,
        onClose: () => undefined,
      }),
    ),
  );
}
describe("API key mode form", () => {
  test("personal creation retains custom-key input and one-time secret affordance", () => {
    const markup = render("create", null);
    expect(markup).toContain("Personal");
    expect(markup).toContain("Share template");
    expect(markup).toContain("Custom API key value (optional)");
  });

  test("share template create/edit never renders a raw-key input", () => {
    const createMarkup = render("create", shareRecord);
    const editMarkup = render("edit", shareRecord);
    expect(createMarkup).toContain("does not authenticate requests");
    expect(editMarkup).toContain("does not authenticate requests");
    expect(createMarkup).not.toContain("Custom API key value");
    expect(editMarkup).not.toContain("Custom API key value");
  });
  test("share submission omits a raw bearer value while personal submission can carry one", () => {
    const shareBody = JSON.stringify(keyCredentialFields("share", "never-send-this", "rk_"));
    const personalBody = JSON.stringify(keyCredentialFields("personal", "rk_personal-once", "rk_"));
    expect(shareBody).not.toContain("never-send-this");
    expect(shareBody).toContain('"keyMode":"share"');
    expect(personalBody).toContain('"key":"rk_personal-once"');
  });
  test("only personal creation or conversion exposes an optional one-time secret", () => {
    expect(oneTimeSecretForMode("personal", "rk_once")).toBe("rk_once");
    expect(oneTimeSecretForMode("share", "must-not-show")).toBeNull();
    expect(oneTimeSecretForMode("personal", undefined)).toBeNull();
  });
});

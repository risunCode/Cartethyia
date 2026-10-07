import { describe, expect, test } from "bun:test";
import { probeFailureToast } from "../../src/features/provider-detail/sections/probe-toast";

/**
 * A failed probe used to put the model in the title and then repeat
 * `provider/model via wire path` at the head of the body, so the upstream
 * sentence — the only part that says what failed — was the last thing read.
 * The title carries the identity and the wire; the body is the failure.
 */
describe("probeFailureToast", () => {
  test("the wire moves into the title and the body is the upstream sentence", () => {
    const { title, detail } = probeFailureToast(
      "codex",
      "gpt-5.5",
      "responses — Encountered invalidated oauth token for user, failing request (token_revoked (upstream 401)) [req a46c4d32dd0bf408-SIN]",
    );
    expect(title).toBe("codex/gpt-5.5 probe failed via responses");
    expect(detail).toBe(
      "Encountered invalidated oauth token for user, failing request (token_revoked (upstream 401)) [req a46c4d32dd0bf408-SIN]",
    );
  });

  test("a body with no wire prefix stays whole", () => {
    const { title, detail } = probeFailureToast("codex", "gpt-5.5", "Model probe failed");
    expect(title).toBe("codex/gpt-5.5 probe failed");
    expect(detail).toBe("Model probe failed");
  });

  test("an absent error falls back to a readable line", () => {
    expect(probeFailureToast("codex", "gpt-5.5", undefined).detail).toBe("Unknown error");
  });
});

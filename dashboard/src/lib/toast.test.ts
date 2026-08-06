import { beforeEach, describe, expect, test, vi } from "vitest";

const sonnerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: sonnerMocks }));

import { toast } from "./toast";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getCopyAction(call: unknown[]): { label: string; onClick: () => void } {
  const options = call[1];
  if (!isRecord(options) || !isRecord(options.action) || typeof options.action.label !== "string" || typeof options.action.onClick !== "function") {
    throw new Error("expected a copy action");
  }
  const onClick = options.action.onClick;
  return { label: options.action.label, onClick: () => { onClick(); } };
}

describe("toast copy action", () => {
  const writeText = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    sonnerMocks.error.mockReset();
    sonnerMocks.success.mockReset();
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  test("adds a Copy action and copies message plus description", async () => {
    toast.success("Saved", { description: "Provider configuration updated" });

    const action = getCopyAction(sonnerMocks.success.mock.calls[0] ?? []);
    expect(action.label).toBe("Copy");

    action.onClick();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("Saved\nProvider configuration updated");
    expect(sonnerMocks.success).toHaveBeenCalledWith("Toast content copied", { duration: 2_000 });
  });

  test("keeps an existing primary action and places Copy in the secondary action", () => {
    const addAccount = vi.fn();
    toast.error("No stored accounts", { action: { label: "Add account", onClick: addAccount } });

    const options = sonnerMocks.error.mock.calls[0]?.[1];
    expect(options).toEqual(expect.objectContaining({
      action: expect.objectContaining({ label: "Add account", onClick: addAccount }),
      cancel: expect.objectContaining({ label: "Copy" }),
    }));
  });
});

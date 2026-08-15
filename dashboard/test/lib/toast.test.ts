import { beforeEach, describe, expect, test, vi } from "vitest";
import { getToastRecords, toast } from "../../src/lib/toast";

describe("toast copy action", () => {
  const writeText = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    writeText.mockClear();
    toast.dismiss();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  test("adds a Copy action and copies message plus description", async () => {
    toast.success("Saved", { description: "Provider configuration updated" });

    const action = getToastRecords()[0]?.action;
    expect(action).toBeDefined();
    if (action === undefined) return;
    expect(action.label).toBe("Copy");

    action.onClick();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("Saved\nProvider configuration updated");
    await vi.waitFor(() => expect(getToastRecords().at(-1)?.message).toBe("Toast content copied"));
  });

  test("keeps an existing primary action and places Copy in the secondary action", () => {
    const addAccount = vi.fn();
    toast.error("No stored accounts", { action: { label: "Add account", onClick: addAccount } });

    const record = getToastRecords()[0];
    expect(record?.action).toEqual(expect.objectContaining({ label: "Add account", onClick: addAccount }));
    expect(record?.cancel).toEqual(expect.objectContaining({ label: "Copy" }));
  });
});

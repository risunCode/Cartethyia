import { beforeEach, describe, expect, test } from "vitest";
import { toast } from "../../src/lib/toast";

describe("official Sonner toast API", () => {
  beforeEach(() => {
    toast.dismiss();
  });

  test("exposes the standard success and error methods", () => {
    expect(typeof toast.success).toBe("function");
    expect(typeof toast.error).toBe("function");
    expect(typeof toast.dismiss).toBe("function");
  });
});

import { describe, expect, test } from "bun:test";
import { extractHtmlTitle } from "../../src/transport/failure-policy";

describe("extractHtmlTitle", () => {
  test("returns the page title when present", () => {
    const html = "<html><head><title>502 Bad Gateway</title></head><body>cf</body></html>";
    expect(extractHtmlTitle(html)).toBe("502 Bad Gateway");
  });

  test("collapses whitespace inside the title", () => {
    const html = "<title>  Error\n  1033\tRay ID  </title>";
    expect(extractHtmlTitle(html)).toBe("Error 1033 Ray ID");
  });

  test("falls back to a tag-stripped excerpt when no title exists", () => {
    const html = "<div>Access</div> <div>denied</div>";
    expect(extractHtmlTitle(html)).toBe("Access denied");
  });

  test("returns empty string for empty input", () => {
    expect(extractHtmlTitle("")).toBe("");
  });
});

import { describe, expect, test, vi } from "vitest";
import { guardLoader, router } from "./router";

describe("dashboard router", () => {
  test("guards protected routes and preserves destination", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const result = await guardLoader({ request: new Request("http://localhost/console/providers?tab=models") });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("location")).toBe("/login?next=%2Fproviders");
  });

  test("allows authenticated route loads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    await expect(guardLoader({ request: new Request("http://localhost/console/overview") })).resolves.toBeNull();
  });

  test("keeps all console sections registered", () => {
    const shell = router.routes.find((route) => route.path === "/");
    const paths = shell?.children?.map((route) => route.path).filter((path): path is string => typeof path === "string") ?? [];
    expect(paths).toEqual(expect.arrayContaining(["overview", "usage", "providers", "model-studio", "proxy-requests", "console-log", "settings", "advanced"]));
  });
});

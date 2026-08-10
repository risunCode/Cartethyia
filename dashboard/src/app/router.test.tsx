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

  test("keeps canonical console sections and advanced routes registered", () => {
    const shell = router.routes.find((route) => route.path === "/");
    const children = shell?.children ?? [];
    const paths = children.map((route) => route.path).filter((path): path is string => typeof path === "string");

    expect(paths).toEqual(expect.arrayContaining([
      "overview",
      "usage",
      "providers",
      "model-studio",
      "proxy-requests",
      "console-log",
      "settings",
      "advanced",
      "advanced/filter-sanitize",
      "advanced/token-saver",
      "advanced/cli-tools",
      "advanced/automation",
    ]));
  });

  test("keeps legacy advanced URLs as explicit redirects", () => {
    const shell = router.routes.find((route) => route.path === "/");
    const children = shell?.children ?? [];
    const customization = children.find((route) => route.path === "customization");
    const tokenSaver = children.find((route) => route.path === "token-saver");

    expect(customization?.element).toMatchObject({ props: { to: "/advanced", replace: true } });
    expect(tokenSaver?.element).toMatchObject({ props: { to: "/advanced/token-saver", replace: true } });
  });
});

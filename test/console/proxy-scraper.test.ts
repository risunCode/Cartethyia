import { describe, expect, test } from "bun:test";
import { mapWithConcurrency, parseProxyLine, scrapeProxies, type FetchLike } from "../../src/console/services/proxy-scraper";

describe("proxy scraper", () => {
  test("normalizes supported proxy lines and preserves explicit default ports", () => {
    expect(parseProxyLine("http://1.2.3.4:80", "US")).toEqual({
      url: "http://1.2.3.4:80",
      protocol: "http",
      host: "1.2.3.4",
      port: 80,
      country: "US",
    });
    expect(parseProxyLine("socks5h://10.0.0.2:1080", null)?.protocol).toBe("socks5");
    expect(parseProxyLine("not-a-proxy", null)).toBeNull();
    expect(parseProxyLine("http://127.0.0.1:0", null)).toBeNull();
  });

  test("limits active workers and preserves result order", async () => {
    let active = 0;
    let maximumActive = 0;
    let signalStarted: () => void = () => {};
    let releaseWorkers: () => void = () => {};
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseWorkers = resolve; });
    const pending = mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (active === 2) signalStarted();
      await release;
      active -= 1;
      return value * 2;
    });

    await started;
    expect(maximumActive).toBe(2);
    releaseWorkers();
    expect(await pending).toEqual([2, 4, 6, 8, 10, 12]);
  });

  test("fetches all selected sources concurrently and de-duplicates URLs", async () => {
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes("proxyscrape")) return new Response("http://1.1.1.1:80\n");
      if (url.includes("geonode")) return new Response(JSON.stringify({ data: [{ ip: "1.1.1.1", port: "80", protocols: ["http"] }, { ip: "2.2.2.2", port: "8080", protocols: ["http"] }] }));
      return new Response("socks5://3.3.3.3:1080\n");
    };

    const result = await scrapeProxies({ source: "all", limit: 0 }, fetchFn);
    expect(result.map((proxy) => proxy.url)).toEqual(["http://1.1.1.1:80", "http://2.2.2.2:8080", "socks5://3.3.3.3:1080"]);
  });

  test("propagates an abort so the search button can stop an active scrape", async () => {
    const controller = new AbortController();
    const fetchFn: FetchLike = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    const pending = scrapeProxies({ source: "proxyscrape" }, fetchFn, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

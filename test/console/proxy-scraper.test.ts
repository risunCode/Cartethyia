import { describe, expect, test } from "bun:test";
import { canonicalProxyKey, isScrapeSource, mapWithConcurrency, normalizeScrapeSource, parseHostPortLine, parseProxyLine, scrapeProxies, scrapeProxiesDetailed, SCRAPE_SOURCE_CATALOG, type FetchLike } from "../../src/console/services/proxy-scraper";

describe("proxy scraper", () => {
  test("normalizes supported proxy lines and preserves explicit default ports", () => {
    expect(parseProxyLine("http://1.2.3.4:80", "US")).toEqual({
      url: "http://1.2.3.4:80",
      protocol: "http",
      host: "1.2.3.4",
      port: 80,
      country: "US",
      source: "proxyscrape",
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
    expect(result.map((proxy) => proxy.url)).toEqual(["http://1.1.1.1:80", "socks5://3.3.3.3:1080", "http://2.2.2.2:8080"]);
  });

  test("parses raw host-port feeds and fetches HTTP and SOCKS5 feeds concurrently", async () => {
    expect(parseHostPortLine("203.0.113.7:8080", "http", null)).toEqual({
      url: "http://203.0.113.7:8080",
      protocol: "http",
      host: "203.0.113.7",
      port: 8080,
      country: null,
      source: "thespeedx",
    });
    expect(parseHostPortLine("# Updated Proxies: now", "http", null)).toBeNull();
    const requested: string[] = [];
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/http.txt")) return new Response("203.0.113.7:8080\n");
      return new Response("203.0.113.8:1080\n");
    };
    const result = await scrapeProxies({ source: "thespeedx", protocol: "all", limit: 0 }, fetchFn);
    expect(requested).toHaveLength(2);
    expect(result.map((proxy) => proxy.url)).toEqual(["http://203.0.113.7:8080", "socks5://203.0.113.8:1080"]);
  });

  test("does not violate regional filtering for global-only feeds", async () => {
    let requested = 0;
    const result = await scrapeProxies({ source: "vpslab", country: "US" }, async () => {
      requested += 1;
      return new Response("203.0.113.7:8080\n");
    });
    expect(result).toEqual([]);
    expect(requested).toBe(0);
  });

  test("centralizes source catalog, canonical keys, and bounded diagnostics", async () => {
    expect(isScrapeSource("thespeedx")).toBe(true);
    expect(isScrapeSource("unknown")).toBe(false);
    expect(normalizeScrapeSource("unknown")).toBe("all");
    expect(canonicalProxyKey({ protocol: "HTTP", host: "Example.COM", port: 80 })).toBe("http://example.com:80");
    expect(SCRAPE_SOURCE_CATALOG.some((source) => source.id === "hproxy" && source.countryAware === false)).toBe(true);
    const detailed = await scrapeProxiesDetailed({ source: "thespeedx", protocol: "http", limit: 1 }, async () => new Response("203.0.113.1:8080\n203.0.113.2:8080\n"));
    expect(detailed.proxies).toHaveLength(1);
    expect(detailed.proxies[0]!.source).toBe("thespeedx");
    expect(detailed.sources).toEqual([{ id: "thespeedx", label: "TheSpeedX", status: "fulfilled", count: 2 }]);
  });

  test("reports protocol-level failures without hiding successful feed results", async () => {
    const detailed = await scrapeProxiesDetailed({ source: "thespeedx", protocol: "all", limit: 10 }, async (input) => {
      const url = String(input);
      if (url.endsWith("/http.txt")) throw new Error("HTTP feed unavailable");
      return new Response("203.0.113.9:1080\n");
    });
    expect(detailed.proxies.map((proxy) => proxy.url)).toEqual(["socks5://203.0.113.9:1080"]);
    expect(detailed.sources).toEqual([{
      id: "thespeedx",
      label: "TheSpeedX",
      status: "fulfilled",
      count: 1,
      protocols: {
        http: { status: "failed", count: 0, error: "HTTP feed unavailable" },
        socks5: { status: "fulfilled", count: 1 },
      },
    }]);
  });

  test("canonicalizes IPv6 proxy keys consistently", () => {
    expect(canonicalProxyKey({ protocol: "HTTP", host: "[2001:DB8::1]", port: 8080 })).toBe("http://2001:db8::1:8080");
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

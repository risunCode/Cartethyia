import { describe, expect, test } from "bun:test";
import { ProxyService } from "../../src/console/services/proxy";
import type { ProxyRepository, ProxySettingsRepository, RouteTransitionStore } from "../../src/console/views";

function createService() {
  const rows: Array<{ id: string; protocol: "http" | "https" | "socks5"; host: string; port: number }> = [];
  const repo = {
    list: async () => rows,
    create: async (input: { readonly protocol: "http" | "https" | "socks5"; readonly host: string; readonly port: number }) => {
      const id = `proxy-${rows.length + 1}`;
      rows.push({ id, protocol: input.protocol, host: input.host, port: input.port });
      return { id, passwordHint: null };
    },
  } as unknown as ProxyRepository;
  return new ProxyService(repo, {} as ProxySettingsRepository, {} as RouteTransitionStore);
}

describe("proxy candidate import", () => {
  test("deduplicates canonical endpoints within one import and across imports", async () => {
    const service = createService();

    const first = await service.importCandidates({
      items: [
        { protocol: "http", host: "Example.COM", port: 80 },
        { protocol: "http", host: " example.com ", port: 80 },
        { protocol: "socks5", host: "127.0.0.1", port: 1080 },
        { protocol: "http", host: "", port: 80 },
      ],
    });

    expect(first).toEqual({ added: 2, skipped: 2, keys: ["http://example.com:80", "http://example.com:80", "socks5://127.0.0.1:1080"] });

    const second = await service.importCandidates({ items: [{ protocol: "http", host: "EXAMPLE.com", port: 80 }] });
    expect(second).toEqual({ added: 0, skipped: 1, keys: ["http://example.com:80"] });
  });
});

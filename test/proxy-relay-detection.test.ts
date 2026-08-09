import { describe, expect, test } from "bun:test";

import { isProxyRelayHost } from "../src/console/input-sanitizers";

describe("proxy relay hostname detection", () => {
  test("recognizes Vercel, Cloudflare Workers, and Netlify relay hosts", () => {
    expect(isProxyRelayHost("merry-beijinho-664396.netlify.app")).toBe(true);
    expect(isProxyRelayHost("MERRY-BEIJINHO-664396.NETLIFY.APP.")).toBe(true);
    expect(isProxyRelayHost("relay.example.vercel.app")).toBe(true);
    expect(isProxyRelayHost("relay.example.workers.dev")).toBe(true);
  });

  test("does not classify unrelated hostnames as managed relays", () => {
    expect(isProxyRelayHost("netlify.app.example.com")).toBe(false);
    expect(isProxyRelayHost("not-netlify.app.example")).toBe(false);
    expect(isProxyRelayHost("example.com")).toBe(false);
  });
});

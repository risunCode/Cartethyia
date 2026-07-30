/** SSRF guard tests — blocks private/loopback/metadata IPs. */

import { describe, expect, test } from "bun:test";
import { assertPublicUrl, validatePublicUrl } from "../../src/http/ssrf-guard";

describe("assertPublicUrl", () => {
  test("allows valid public http URLs", () => {
    expect(() => assertPublicUrl("http://proxy.example.com:8080")).not.toThrow();
    expect(() => assertPublicUrl("https://secure-proxy.example.com:443")).not.toThrow();
    expect(() => assertPublicUrl("socks5://proxy.example.com:1080")).not.toThrow();
  });

  test("blocks localhost", () => {
    expect(() => assertPublicUrl("http://localhost:8080")).toThrow("blocked");
    expect(() => assertPublicUrl("http://localhost")).toThrow("blocked");
  });

  test("blocks 127.x.x.x loopback", () => {
    expect(() => assertPublicUrl("http://127.0.0.1:8080")).toThrow("blocked");
    expect(() => assertPublicUrl("http://127.0.0.2:3128")).toThrow("blocked");
  });

  test("blocks RFC 1918 private ranges", () => {
    expect(() => assertPublicUrl("http://10.0.0.1:8080")).toThrow("blocked");
    expect(() => assertPublicUrl("http://10.255.255.1:8080")).toThrow("blocked");
    expect(() => assertPublicUrl("http://172.16.0.1:8080")).toThrow("blocked");
    expect(() => assertPublicUrl("http://172.31.255.1:8080")).toThrow("blocked");
    expect(() => assertPublicUrl("http://192.168.1.1:8080")).toThrow("blocked");
    expect(() => assertPublicUrl("http://192.168.0.1:8080")).toThrow("blocked");
  });

  test("blocks link-local (cloud metadata)", () => {
    expect(() => assertPublicUrl("http://169.254.169.254/latest/meta-data")).toThrow("blocked");
    expect(() => assertPublicUrl("http://169.254.0.1:8080")).toThrow("blocked");
  });

  test("blocks 0.0.0.0", () => {
    expect(() => assertPublicUrl("http://0.0.0.0:8080")).toThrow("blocked");
  });

  test("blocks IPv6 loopback", () => {
    expect(() => assertPublicUrl("http://[::1]:8080")).toThrow("blocked");
  });

  test("blocks IPv6 link-local and unique-local ranges", () => {
    expect(() => assertPublicUrl("http://[fe80::1]:8080")).toThrow("blocked");
    expect(() => assertPublicUrl("http://[fc00::1]:8080")).toThrow("blocked");
    expect(() => assertPublicUrl("http://[fd12:3456::1]:8080")).toThrow("blocked");
  });

  test("blocks IPv4-mapped IPv6 loopback", () => {
    expect(() => assertPublicUrl("http://[::ffff:127.0.0.1]:8080")).toThrow("blocked");
  });

  test("blocks internal domain suffixes", () => {
    expect(() => assertPublicUrl("http://my-service.internal:8080")).toThrow("blocked");
    expect(() => assertPublicUrl("http://my-host.local:8080")).toThrow("blocked");
    expect(() => assertPublicUrl("http://my-app.localhost:8080")).toThrow("blocked");
  });

  test("blocks cloud metadata hostnames", () => {
    expect(() => assertPublicUrl("http://metadata.google.internal:80")).toThrow("blocked");
  });

  test("blocks disallowed protocols", () => {
    expect(() => assertPublicUrl("ftp://proxy.example.com:21")).toThrow("not allowed");
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow("not allowed");
  });

  test("blocks invalid URLs", () => {
    expect(() => assertPublicUrl("not-a-url")).toThrow("not a valid URL");
    expect(() => assertPublicUrl("")).toThrow("not a valid URL");
  });
});

describe("validatePublicUrl", () => {
  test("returns null for valid URLs", () => {
    expect(validatePublicUrl("http://proxy.example.com:8080")).toBeNull();
    expect(validatePublicUrl("https://proxy.example.com:443")).toBeNull();
  });

  test("returns error string for blocked URLs", () => {
    expect(validatePublicUrl("http://localhost:8080")).toContain("blocked");
    expect(validatePublicUrl("http://10.0.0.1:8080")).toContain("blocked");
    expect(validatePublicUrl("http://169.254.169.254")).toContain("blocked");
  });
});

describe("SSRF integration with proxy pools", () => {
  test("parseProxyUrl rejects private IPs", async () => {
    const { parseProxyUrl } = await import("../../src/console/db/repos/proxy-pools");
    expect(parseProxyUrl("http://10.0.0.1:8080")).toBeNull();
    expect(parseProxyUrl("http://localhost:3128")).toBeNull();
    expect(parseProxyUrl("http://169.254.169.254:80")).toBeNull();
    expect(parseProxyUrl("http://192.168.1.1:8080")).toBeNull();
  });

  test("parseProxyUrl accepts public URLs", async () => {
    const { parseProxyUrl } = await import("../../src/console/db/repos/proxy-pools");
    expect(parseProxyUrl("http://proxy.example.com:8080")).not.toBeNull();
    expect(parseProxyUrl("https://secure-proxy.example.com:443")).not.toBeNull();
    expect(parseProxyUrl("socks5://proxy.example.com:1080")).not.toBeNull();
  });
});

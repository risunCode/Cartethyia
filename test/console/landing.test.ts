import { describe, expect, test } from "bun:test";
import { app } from "../../src/app";

describe("public Cartethyia landing page", () => {
  test("serves the kingdom page at root without console authentication", async () => {
    const response = await app.handle(new Request("http://localhost/"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("fonts.googleapis.com");
    expect(body).toContain("By Cartethyia");
    expect(body).toContain("Fleurdelys");
    expect(body).toContain("芙露德莉斯");
    expect(body).toContain("id=\"features\"");
    expect(body).toContain("Community");
    expect(body).toContain("github.com/risuncode/cartethyia");
    expect(body).toContain("discord.gg/zFcNPJM6qM");
    expect(body).toContain("data-gallery");
    expect(body).toContain("/landing-assets/landing.js");
    expect(body).toContain("data-welcome");
    expect(body).toContain("data-welcome-suppress");
    expect(body).toContain("data-reveal");
    expect(body).toContain("data-back-to-top");
    expect(body).toContain("echoborn-cartethyia-awakens.1920x1080.mp4");
    expect(body).toContain("/console/");
  });

  test("serves the provided hero video from a public asset route", async () => {
    const response = await app.handle(new Request("http://localhost/landing-assets/echoborn-cartethyia-awakens.1920x1080.mp4"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("video/mp4");
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  test("serves the cached official artwork from a public asset route", async () => {
    const response = await app.handle(new Request("http://localhost/landing-assets/cartethyia-profile-header.jpg"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/jpeg");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100_000);
  });
});

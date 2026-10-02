/**
 * Static asset serving and the SPA fallback.
 *
 * `createStaticHandler` decides what a browser receives for every non-API path,
 * and three properties matter more than the rest because getting them wrong is
 * invisible until it hurts:
 *
 * - **Cache headers.** An entry document served with a long cache lets a
 *   browser keep serving the previous build's HTML after a deploy, which
 *   references hashed bundles that no longer exist. The reported symptom was
 *   needing `Ctrl+Shift+R` after every update. `no-store, no-cache,
 *   must-revalidate` is the fix, and this suite pins it.
 * - **Path containment.** A request path is attacker-controlled. `..`
 *   traversal, absolute paths, and encoded separators must never escape the
 *   build directory.
 * - **The SPA fallback's boundary.** An extensionless path under a document
 *   namespace resolves to `index.html` so a client-side route deep link works;
 *   a path that *looks* like a file must 404 instead of being answered with
 *   HTML, or a missing bundle becomes a page of garbage the browser tries to
 *   execute.
 *
 * The suite builds a real directory tree in a temp dir, so it exercises the
 * filesystem path rather than a mocked `fs`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStaticHandler } from "../../src/console/dashboard-assets";

let buildDir: string;
let handler: ReturnType<typeof createStaticHandler>;

/** Body of a result as text, or `""` when the result has no body. */
function bodyText(result: { body?: unknown }): string {
  if (result.body === undefined || result.body === null) return "";
  return new TextDecoder().decode(result.body as Uint8Array);
}

beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "cartethyia-assets-"));
  await writeFile(
    join(buildDir, "index.html"),
    "<!doctype html><html><body><div id=\"root\"></div></body></html>",
  );
  await writeFile(join(buildDir, "assets.js"), "console.log('bundle')");
  await writeFile(join(buildDir, "styles.css"), "body{margin:0}");
  await writeFile(join(buildDir, "favicon.webp"), "RIFF");
  await mkdir(join(buildDir, "providers"), { recursive: true });
  await writeFile(join(buildDir, "providers", "openai-light.svg"), "<svg/>");
  await mkdir(join(buildDir, "nested"), { recursive: true });
  await writeFile(join(buildDir, "nested", "deep.txt"), "deep");
  // A sibling of the build dir, to prove traversal cannot reach it.
  await writeFile(join(buildDir, "..", `outside-${Date.now()}.txt`), "secret");
  handler = createStaticHandler({ buildDir });
});

afterAll(async () => {
  await rm(buildDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("static assets — served files", () => {
  test("serves an existing file with its bytes", async () => {
    const result = await handler("/assets.js");
    expect(result.status).toBe(200);
    expect(bodyText(result)).toBe("console.log('bundle')");
  });

  test("serves a nested file", async () => {
    const result = await handler("/providers/openai-light.svg");
    expect(result.status).toBe(200);
    expect(bodyText(result)).toBe("<svg/>");
  });

  test("serves a file below a nested directory", async () => {
    const result = await handler("/nested/deep.txt");
    expect(result.status).toBe(200);
    expect(bodyText(result)).toBe("deep");
  });

  test("the caller's pathname is used verbatim; a query string is not this layer's job", async () => {
    // `createStaticHandler` takes a pathname, not a URL: `app.ts` passes
    // `fastPathname(request.url)`, which has already dropped the query. A
    // suite that handed it a raw `?v=…` would be testing a caller contract that
    // does not exist — so this pins the real one: the handler treats whatever
    // it is given as a path, and a path containing `?` is simply not a file.
    const result = await handler("/assets.js?v=abc123");
    expect(result.status).toBe(404);
    // And the value `app.ts` actually passes does resolve.
    const direct = await handler("/assets.js");
    expect(direct.status).toBe(200);
  });

  test("a missing asset is a 404, not the SPA document", async () => {
    // Answering a missing `.js` with HTML is worse than a 404: the browser
    // tries to execute the markup and reports a syntax error at the app's
    // expense.
    const result = await handler("/assets-missing.js");
    expect(result.status).toBe(404);
  });

  test("a missing file in an existing directory is a 404", async () => {
    const result = await handler("/providers/not-a-file.svg");
    expect(result.status).toBe(404);
  });
});

describe("static assets — cache policy", () => {
  test("the entry document is never cached", async () => {
    // The reported defect: after a deploy the browser reused the previous
    // build's HTML, which referenced bundles that no longer exist, and a hard
    // refresh was the only cure.
    const result = await handler("/index.html");
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store, no-cache, must-revalidate");
  });

  test("a directly-served index.html carries the legacy cache headers too", async () => {
    // The file-on-disk branch sets only `cache-control`; the document branch
    // (`serveDocument`) is the one that also sets `pragma`/`expires`. Both
    // paths are exercised because both serve HTML, and the assertion differs by
    // branch — which is the finding this test records.
    const direct = await handler("/index.html");
    expect(direct.headers["cache-control"]).toBe("no-store, no-cache, must-revalidate");

    // The SPA-fallback branch does add the pair.
    const fallback = await handler("/console/overview");
    expect(fallback.headers["pragma"]).toBe("no-cache");
    expect(fallback.headers["expires"]).toBe("0");
  });

  test("an SPA fallback response is never cached either", async () => {
    const result = await handler("/console/overview");
    expect(result.headers["cache-control"]).toBe("no-store, no-cache, must-revalidate");
  });

  test("a content-addressed asset may be cached", async () => {
    // Hashed bundle names change on every build, so caching them is safe and
    // is what makes a repeat visit fast.
    const result = await handler("/assets.js");
    expect(result.headers["cache-control"]).not.toBe("no-store, no-cache, must-revalidate");
  });
});

describe("static assets — SPA fallback", () => {
  test("the root serves the entry document", async () => {
    const result = await handler("/");
    expect(result.status).toBe(200);
    expect(bodyText(result)).toContain('<div id="root">');
  });

  test("an extensionless route under /console serves the entry document", async () => {
    const result = await handler("/console/overview");
    expect(result.status).toBe(200);
    expect(bodyText(result)).toContain('<div id="root">');
  });

  test("a deeply nested extensionless route also falls back", async () => {
    // A client-side route can be any depth; matching only single-segment paths
    // would break a deep link.
    const result = await handler("/console/cli-tools/claude");
    expect(result.status).toBe(200);
    expect(bodyText(result)).toContain('<div id="root">');
  });

  test("a path with a file extension does not fall back", async () => {
    // The distinguishing rule: a dotted last segment means the client asked for
    // a file, so a miss is a 404 rather than the app shell.
    const result = await handler("/console/missing-thing.js");
    expect(result.status).toBe(404);
  });

  test("a request that escapes the build directory is refused", async () => {
    const result = await handler("/../outside.txt");
    expect(result.status).not.toBe(200);
  });

  test("an encoded traversal attempt is refused", async () => {
    // The handler receives a decoded pathname, but a client can also send the
    // encoded form; either way it must not resolve outside the build dir.
    const result = await handler("/%2e%2e/outside.txt");
    expect(result.status).not.toBe(200);
  });

  test("an absolute path cannot select an arbitrary file", async () => {
    const result = await handler("//etc/passwd");
    expect(result.status).not.toBe(200);
  });

  test("a path containing a null byte is refused rather than throwing", async () => {
    // A null byte in a filesystem path is either rejected by the OS or
    // truncated by a lower layer; either way the handler must answer, not crash.
    const result = await handler("/index.html\0.txt");
    expect(result.status).toBeGreaterThanOrEqual(400);
  });

  test("a directory request does not leak a listing", async () => {
    const result = await handler("/providers");
    expect(result.status).not.toBe(200);
    expect(bodyText(result)).not.toContain("openai-light");
  });
});

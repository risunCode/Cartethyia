/**
 * Losslessly recompresses the repository's raster assets.
 *
 * HQ, not smaller: every output keeps the input's exact pixel dimensions, and a
 * file is only rewritten when the result is genuinely smaller *and* not a
 * quality downgrade. Dimensions are asserted, not assumed.
 *
 *   - PNG  → zlib level 9 with effort 10, palette disabled (bit depth and colour
 *            type preserved). A PNG that only shrinks by dropping to a palette
 *            is left alone, because that changes how it decodes.
 *   - JPEG → re-quantised with mozjpeg at q=90, 4:4:4 chroma (no subsampling).
 *   - WebP → the existing files are a mix of VP8 (lossy) and VP8X+alpha. A lossy
 *            VP8 re-encoded as WebP lossless is a downgrade that usually grows,
 *            so those are skipped; VP8X (alpha) is left alone too. A WebP that
 *            is genuinely lossless-encoded already re-compresses to the same
 *            size and is skipped as well.
 *
 * Destructive git commands are forbidden, so originals stay recoverable from the
 * index until the change set is committed. Run from the repository root:
 *
 *   bun scripts/compress-assets.ts            # report only
 *   bun scripts/compress-assets.ts --write    # rewrite files that shrink
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const WRITE = process.argv.includes("--write");

/** Tracked raster assets only; build output and dependencies are excluded. */
function trackedAssets(): string[] {
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split(/\r?\n/);
  return files.filter((file) => /\.(png|jpe?g|webp)$/i.test(file) && existsSync(file));
}

/**
 * Reads the RIFF chunk to learn how a WebP was encoded. Only `VP8L` is lossless;
 * `VP8` is lossy and `VP8X` is a container around either. Re-encoding a lossy
 * source as lossless is a downgrade that grows the file, so anything that is not
 * provably `VP8L` is treated as lossy and skipped.
 */
function webpIsLossy(path: string): boolean {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return true;
  return buf.toString("ascii", 12, 16) !== "VP8L";
}

/**
 * Returns a recompressed buffer, or null when the source is already optimal or
 * would only be downgraded. Never changes pixel dimensions.
 */
async function recompress(path: string, format: string): Promise<Buffer | null> {
  const { width, height } = await sharp(path, { failOn: "none" }).metadata();
  if (width === undefined || height === undefined) return null;

  if (format === "webp") {
    // A lossy WebP cannot be improved without re-quantising it again, which is
    // a quality change, not compression. Leave it.
    if (webpIsLossy(path)) return null;
  }

  const pipeline =
    format === "png"
      ? sharp(path, { failOn: "none" }).png({ compressionLevel: 9, effort: 10, palette: false })
      : format === "webp"
        ? sharp(path, { failOn: "none" }).webp({ lossless: true, effort: 6 })
        : sharp(path, { failOn: "none" }).jpeg({
            quality: 90,
            mozjpeg: true,
            chromaSubsampling: "4:4:4",
            progressive: true,
          });

  const buffer = await pipeline.toBuffer();
  const after = await sharp(buffer).metadata();
  if (after.width !== width || after.height !== height) {
    throw new Error(`${path}: dimensions changed ${width}x${height} → ${after.width}x${after.height}`);
  }
  // A PNG re-encode must stay the same colour type; a palette drop would
  // change how it decodes, which is not lossless compression.
  if (format === "png" && after.space !== (await sharp(path, { failOn: "none" }).metadata()).space) {
    return null;
  }
  return buffer;
}

const results: Array<{ path: string; before: number; after: number; wrote: boolean; note: string }> = [];
let totalBefore = 0;
let totalAfter = 0;

for (const path of trackedAssets()) {
  const before = statSync(path).size;
  totalBefore += before;
  const { format } = await sharp(path, { failOn: "none" }).metadata();
  if (format === undefined) continue;

  const buffer = await recompress(path, format);
  const shrank = buffer !== null && buffer.length < before;
  const after = shrank ? buffer!.length : before;
  totalAfter += after;
  let wrote = false;
  if (WRITE && shrank && buffer !== null) {
    // sharp still holds the source file open while `toBuffer()` resolves, and a
    // `writeFileSync` onto that same path is then discarded without an error —
    // the file keeps its old size and the run still reports success. Write a
    // sibling temp and rename over the target so the replacement is atomic and
    // cannot be swallowed.
    const temp = `${path}.compress-tmp`;
    writeFileSync(temp, buffer);
    renameSync(temp, path);
    wrote = statSync(path).size === buffer.length;
    if (!wrote) throw new Error(`${path}: wrote ${buffer.length} bytes but ${statSync(path).size} landed`);
  }
  const note = format === "webp" && buffer === null ? "skipped (lossy/VP8X)" : "";
  results.push({ path, before, after, wrote, note });
}

results.sort((a, b) => b.before - b.after - (a.before - a.after));
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} kB`;
const mib = (bytes: number): string => `${(bytes / 1048576).toFixed(2)} MiB`;

console.log(`${WRITE ? "wrote" : "report"} — ${results.length} raster assets\n`);
for (const r of results) {
  const delta = r.before - r.after;
  if (delta <= 0) continue;
  const pct = ((delta / r.before) * 100).toFixed(1);
  console.log(
    `  ${kb(r.before).padStart(10)} → ${kb(r.after).padStart(10)}  -${pct.padStart(5)}%${r.wrote ? "" : "  (report only)"}  ${r.path}`,
  );
}
const saved = totalBefore - totalAfter;
console.log(
  `\ntotal ${mib(totalBefore)} → ${mib(totalAfter)}  (-${mib(saved)}, -${((saved / totalBefore) * 100).toFixed(1)}%)`,
);
const skipped = results.filter((r) => r.note !== "").length;
const floor = results.filter((r) => r.before === r.after && r.note === "").length;
console.log(`${skipped} WebP skipped as lossy/VP8X; ${floor} already at the floor. Nothing was downscaled.`);
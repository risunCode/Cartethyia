import { createHash } from "node:crypto";

const MASK = 0xffffffffffffffffn;
const PRIME1 = 0x9e3779b185ebca87n;
const PRIME2 = 0xc2b2ae3d27d4eb4fn;
const PRIME3 = 0x165667b19e3779f9n;
const PRIME4 = 0x85ebca77c2b2ae63n;
const PRIME5 = 0x27d4eb2f165667c5n;
const CCH_SEED = 0x4d659218e32a3268n;
const PLACEHOLDER = "cch=00000";
const encoder = new TextEncoder();

function round(acc: bigint, input: bigint): bigint {
  let value = (acc + input * PRIME2) & MASK;
  value = ((value << 31n) | (value >> 33n)) & MASK;
  return (value * PRIME1) & MASK;
}

function mergeRound(acc: bigint, value: bigint): bigint {
  let result = acc ^ round(0n, value);
  return (result * PRIME1 + PRIME4) & MASK;
}

function read32(bytes: Uint8Array, offset: number): bigint {
  return (
    BigInt(bytes[offset] ?? 0) |
    (BigInt(bytes[offset + 1] ?? 0) << 8n) |
    (BigInt(bytes[offset + 2] ?? 0) << 16n) |
    (BigInt(bytes[offset + 3] ?? 0) << 24n)
  );
}

function read64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1)
    value |= BigInt(bytes[offset + index] ?? 0) << BigInt(index * 8);
  return value;
}

function xxHash64(bytes: Uint8Array, seed: bigint): bigint {
  let offset = 0;
  let hash: bigint;
  if (bytes.length >= 32) {
    let v1 = (seed + PRIME1 + PRIME2) & MASK;
    let v2 = (seed + PRIME2) & MASK;
    let v3 = seed & MASK;
    let v4 = (seed - PRIME1) & MASK;
    while (offset <= bytes.length - 32) {
      v1 = round(v1, read64(bytes, offset));
      v2 = round(v2, read64(bytes, offset + 8));
      v3 = round(v3, read64(bytes, offset + 16));
      v4 = round(v4, read64(bytes, offset + 24));
      offset += 32;
    }
    hash =
      (((v1 << 1n) | (v1 >> 63n)) +
        ((v2 << 7n) | (v2 >> 57n)) +
        ((v3 << 12n) | (v3 >> 52n)) +
        ((v4 << 18n) | (v4 >> 46n))) &
      MASK;
    hash = mergeRound(hash, v1);
    hash = mergeRound(hash, v2);
    hash = mergeRound(hash, v3);
    hash = mergeRound(hash, v4);
  } else hash = (seed + PRIME5) & MASK;
  hash = (hash + BigInt(bytes.length)) & MASK;
  while (offset <= bytes.length - 8) {
    const value = round(0n, read64(bytes, offset));
    hash ^= value;
    hash = (((hash << 27n) | (hash >> 37n)) * PRIME1 + PRIME4) & MASK;
    offset += 8;
  }
  if (offset <= bytes.length - 4) {
    hash ^= (read32(bytes, offset) * PRIME1) & MASK;
    hash = (((hash << 23n) | (hash >> 41n)) * PRIME2 + PRIME3) & MASK;
    offset += 4;
  }
  while (offset < bytes.length) {
    hash ^= (BigInt(bytes[offset] ?? 0) * PRIME5) & MASK;
    hash = (((hash << 11n) | (hash >> 53n)) * PRIME1) & MASK;
    offset += 1;
  }
  hash ^= hash >> 33n;
  hash = (hash * PRIME2) & MASK;
  hash ^= hash >> 29n;
  hash = (hash * PRIME3) & MASK;
  return (hash ^ (hash >> 32n)) & MASK;
}

/** Computes Claude Code's five-hex-digit CCH from the exact outgoing body bytes. */
export function computeClaudeCch(body: Uint8Array): string {
  return (xxHash64(body, CCH_SEED) & 0xfffffn).toString(16).padStart(5, "0");
}

/** Replaces the anchored Claude billing placeholder in a mutable body before sending. */
export function patchClaudeCch(body: Uint8Array): boolean {
  const marker = encoder.encode('"system":[{"type":"text","text":"x-anthropic-billing-header:');
  const placeholder = encoder.encode(PLACEHOLDER);
  let markerIndex = -1;
  outer: for (let index = 0; index <= body.length - marker.length; index += 1) {
    for (let j = 0; j < marker.length; j += 1) if (body[index + j] !== marker[j]) continue outer;
    markerIndex = index;
    break;
  }
  if (markerIndex < 0) return false;
  const start = markerIndex + marker.length;
  const end = Math.min(body.length - placeholder.length, start + 150);
  for (let index = start; index <= end; index += 1) {
    let found = true;
    for (let j = 0; j < placeholder.length; j += 1)
      if (body[index + j] !== placeholder[j]) {
        found = false;
        break;
      }
    if (!found) continue;
    const cch = encoder.encode(computeClaudeCch(body));
    body.set(cch, index + 4);
    return true;
  }
  return false;
}

/** Harness identity instruction, sent on OAuth dispatch. */
export const CLAUDE_CODE_SYSTEM_INSTRUCTION =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Builds the billing header text with the captured version suffix:
 * `cc_version={ver}.{sha256("59cf53e54c78" + chars + ver)[0:3]}` where
 * chars are the 5th/8th/21st chars of the first user text (or "0" when
 * absent). `cc_entrypoint=cli` matches the harness UA `(external, cli)`;
 * an older snapshot used `claude-desktop`, which is unverified from local
 * evidence, so cli is kept with this note.
 */
export function createClaudeBillingText(userText: string, version: string): string {
  const chars = [4, 7, 20].map((index) => userText[index] ?? "0").join("");
  const suffix = createHash("sha256")
    .update(`59cf53e54c78${chars}${version}`)
    .digest("hex")
    .slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=cli; cch=00000;`;
}

/** Patches a string request body and returns its encoded bytes, or undefined when no billing block exists. */
export function patchClaudeCchBody(body: string): Uint8Array | undefined {
  const bytes = encoder.encode(body);
  return patchClaudeCch(bytes) ? bytes : undefined;
}

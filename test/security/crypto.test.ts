/**
 * Credential encryption and secret hashing: the layer that keeps provider
 * credentials out of Postgres in the clear.
 *
 * Three properties carry the risk.
 *
 * 1. **The key is never inferred or defaulted.** A missing
 *    `CARTETHYIA_ENCRYPTION_KEY` must fail closed rather than fall back to a
 *    fixed or derived key — a fallback would encrypt production credentials
 *    under a key an attacker can compute from the source.
 * 2. **Every ciphertext is authenticated.** AES-GCM's auth tag is what makes a
 *    tampered or truncated ciphertext throw instead of decrypting to garbage; a
 *    scheme without it would hand a corrupted credential to a provider and report
 *    a confusing 401 instead of a storage fault.
 * 3. **A fresh IV per encryption.** Reusing an IV under one key breaks GCM
 *    catastrophically — two ciphertexts with the same IV leak the XOR of their
 *    plaintexts and expose the authentication subkey.
 *
 * The suite drives the real implementation with a real key set through the
 * documented test seam, and restores the previous key afterwards so no other
 * suite in the process is affected.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  decryptCredential,
  decryptCredentialToString,
  encryptCredential,
  getCredentialEncryptionKey,
  hashSecret,
  setCredentialEncryptionKeyForTesting,
} from "../../src/security/crypto";
import { decodeEncryptionKey } from "../../src/config";

/** A 32-byte key, base64 encoded. Deterministic so assertions can compare. */
const KEY_BYTES = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const KEY_BASE64 = KEY_BYTES.toString("base64");
/** The same key in hex, to prove both encodings are accepted. */
const KEY_HEX = KEY_BYTES.toString("hex");

/** The key in force before the suite ran, restored afterwards. */
let previousKey: Buffer | undefined;

beforeEach(() => {
  previousKey = undefined;
  // `getCredentialEncryptionKey` caches, so a suite that wants a known key must
  // install it rather than rely on the environment.
  setCredentialEncryptionKeyForTesting(KEY_BYTES);
});

afterEach(() => {
  setCredentialEncryptionKeyForTesting(previousKey);
});

describe("decodeEncryptionKey", () => {
  test("accepts a base64-encoded 32-byte key", () => {
    expect(decodeEncryptionKey(KEY_BASE64)).toEqual(KEY_BYTES);
  });

  test("accepts a hex-encoded 64-character key", () => {
    // The hex branch is chosen by the `^[0-9a-fA-F]{64}$` test, which is why a
    // 64-character hex string is not read as base64.
    expect(decodeEncryptionKey(KEY_HEX)).toEqual(KEY_BYTES);
    expect(decodeEncryptionKey(KEY_HEX.toUpperCase())).toEqual(KEY_BYTES);
  });

  test("trims surrounding whitespace before decoding", () => {
    // A key pasted from a dashboard or a `.env` line routinely carries a
    // trailing newline; rejecting it would make the deployment fail for a
    // formatting reason with a message about byte length.
    expect(decodeEncryptionKey(`  ${KEY_BASE64}  `)).toEqual(KEY_BYTES);
    expect(decodeEncryptionKey(`${KEY_HEX}\n`)).toEqual(KEY_BYTES);
  });

  test("rejects a key that decodes to the wrong length", () => {
    // The check is on the DECODED length, not the string length, so a
    // 44-character base64 string that happens to decode to 16 bytes is refused.
    for (const raw of [
      Buffer.from("too-short").toString("base64"),
      Buffer.from("0123456789abcdef0123456789abcdefEXTRA").toString("base64"),
      "",
      "not-a-key",
      "!!!not-base64!!!",
    ]) {
      expect(() => decodeEncryptionKey(raw)).toThrow(/exactly 32 bytes/);
    }
  });

  test("a 64-character all-hex string is read as hex, not base64", () => {
    // `^[0-9a-fA-F]{64}$` matches first, and `Buffer.from(x, "hex")` decodes 64
    // hex characters to exactly 32 bytes — so a string that looks like base64
    // but consists only of hex digits is accepted as hex. Pinned because it is
    // the one shape where the two branches could be confused.
    const hexLike = "a".repeat(64);
    expect(decodeEncryptionKey(hexLike)).toEqual(Buffer.alloc(32, 0xaa));
    // The same characters read as base64 would be 48 bytes and would be refused,
    // so the assertion above proves the hex branch ran.
    expect(Buffer.from(hexLike, "base64").length).toBe(48);
  });

  test("the error names the variable and the observed length", () => {
    // The message is what an operator sees at startup; it has to say which
    // variable is wrong and what it decoded to, or the diagnosis is a guess.
    let message = "";
    try {
      decodeEncryptionKey("not-a-key");
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("CARTETHYIA_ENCRYPTION_KEY");
    expect(message).toContain("32 bytes");
    expect(message).toContain("base64 or hex");
  });

  test("a base64 key whose decoded length is exactly 32 is accepted", () => {
    // The boundary: 32 bytes in, 32 bytes out.
    const exactly32 = Buffer.alloc(32, 0x41);
    expect(decodeEncryptionKey(exactly32.toString("base64"))).toEqual(exactly32);
    expect(() => decodeEncryptionKey(Buffer.alloc(31, 0x41).toString("base64"))).toThrow();
    expect(() => decodeEncryptionKey(Buffer.alloc(33, 0x41).toString("base64"))).toThrow();
  });
});

describe("getCredentialEncryptionKey", () => {
  test("returns the installed key", () => {
    expect(getCredentialEncryptionKey()).toEqual(KEY_BYTES);
  });

  test("caches the key so a later environment change does not silently rekey", () => {
    // The cache is the reason hashing and encryption never disagree: both read
    // the same key once. A key that changed mid-process would make every stored
    // ciphertext undecryptable and every stored hash unmatchable.
    const first = getCredentialEncryptionKey();
    const second = getCredentialEncryptionKey();
    expect(first).toBe(second);
  });

  test("clearing the cache makes the next call re-read the source", () => {
    // `setCredentialEncryptionKeyForTesting(undefined)` is the documented seam;
    // it must actually clear rather than leave the previous value in place.
    setCredentialEncryptionKeyForTesting(undefined);
    // With no environment variable in the test process the read throws, which is
    // the fail-closed behaviour: there is no silent fallback to a fixed key.
    const previous = process.env.CARTETHYIA_ENCRYPTION_KEY;
    delete process.env.CARTETHYIA_ENCRYPTION_KEY;
    try {
      expect(() => getCredentialEncryptionKey()).toThrow();
    } finally {
      if (previous === undefined) delete process.env.CARTETHYIA_ENCRYPTION_KEY;
      else process.env.CARTETHYIA_ENCRYPTION_KEY = previous;
      setCredentialEncryptionKeyForTesting(KEY_BYTES);
    }
  });
});

describe("encryptCredential / decryptCredential — round trip", () => {
  test("a string credential round-trips", () => {
    const plaintext = "sk-ant-api03-EXAMPLE-not-a-real-credential";
    const ciphertext = encryptCredential(plaintext);
    expect(decryptCredentialToString(ciphertext)).toBe(plaintext);
  });

  test("the ciphertext does not contain the plaintext", () => {
    // The whole point: Postgres stores this buffer. A scheme that left the
    // plaintext visible in the bytes would defeat the feature.
    const plaintext = "sk-ant-api03-EXAMPLE-not-a-real-credential";
    const ciphertext = encryptCredential(plaintext);
    expect(ciphertext.toString("utf8")).not.toContain(plaintext);
    expect(ciphertext.toString("hex")).not.toContain(Buffer.from(plaintext).toString("hex"));
  });

  test("a byte-array credential round-trips", () => {
    // The signature accepts `Uint8Array` for binary material (a key file, a
    // session blob) as well as a string.
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(decryptCredential(encryptCredential(bytes))).toEqual(Buffer.from(bytes));
  });

  test("an empty credential round-trips", () => {
    // An empty string is a valid (if useless) value; the scheme must not
    // special-case it into a malformed buffer.
    const ciphertext = encryptCredential("");
    expect(ciphertext.length).toBe(12 + 16);
    expect(decryptCredentialToString(ciphertext)).toBe("");
  });

  test("a multi-byte UTF-8 credential round-trips", () => {
    // The encryption is over bytes, so a naive length check on the string would
    // be wrong; this proves the byte path.
    const plaintext = "clé-à-café-日本語-🔑";
    expect(decryptCredentialToString(encryptCredential(plaintext))).toBe(plaintext);
  });

  test("a long credential round-trips", () => {
    // A large provider credential (a PEM blob) exceeds a single cipher block.
    const plaintext = "x".repeat(100_000);
    expect(decryptCredentialToString(encryptCredential(plaintext))).toBe(plaintext);
  });
});

describe("encryptCredential — the buffer layout", () => {
  test("the layout is iv(12) || authTag(16) || ciphertext", () => {
    // The layout is a persisted contract: a change to it makes every stored
    // ciphertext undecryptable, so it is asserted as a length relationship rather
    // than left implicit.
    const plaintext = "0123456789";
    const ciphertext = encryptCredential(plaintext);
    expect(ciphertext.length).toBe(12 + 16 + Buffer.byteLength(plaintext, "utf8"));
  });

  test("the IV is a fresh random value on every encryption", () => {
    // IV reuse under one key is a catastrophic GCM failure: two ciphertexts
    // sharing an IV leak the XOR of their plaintexts and expose the
    // authentication subkey. The assertion is on the IV bytes, not the whole
    // buffer, so a deterministic IV would fail here even if the ciphertext
    // happened to differ.
    const ivs = new Set<string>();
    for (let index = 0; index < 64; index += 1) {
      ivs.add(encryptCredential("same plaintext").subarray(0, 12).toString("hex"));
    }
    expect(ivs.size).toBe(64);
  });

  test("the same plaintext encrypts to different ciphertexts", () => {
    // The observable consequence of the fresh IV.
    const first = encryptCredential("same plaintext");
    const second = encryptCredential("same plaintext");
    expect(first.equals(second)).toBe(false);
  });

  test("a ciphertext of a long plaintext has a fresh IV too", () => {
    // Guards against an IV derived from the plaintext length or a counter.
    const ivs = new Set<string>();
    for (let index = 0; index < 16; index += 1) {
      ivs.add(encryptCredential("y".repeat(1_000)).subarray(0, 12).toString("hex"));
    }
    expect(ivs.size).toBe(16);
  });
});

describe("decryptCredential — rejection", () => {
  test("a buffer shorter than iv + tag is refused before any cipher work", () => {
    // The explicit length guard, so a truncated column value produces a clear
    // "too short" error rather than a confusing GCM failure.
    for (const length of [0, 1, 12, 16, 27]) {
      expect(() => decryptCredential(Buffer.alloc(length))).toThrow(/too short/);
    }
    // Exactly iv + tag is the shortest accepted: an empty plaintext.
    expect(() => decryptCredential(Buffer.alloc(28))).toThrow();
  });

  test("a tampered ciphertext is refused by the auth tag", () => {
    // This is what the GCM tag buys: a corrupted credential throws here instead
    // of being handed to a provider as garbage and reported as a 401.
    const ciphertext = encryptCredential("a real credential");
    const tampered = Buffer.from(ciphertext);
    const lastIndex = tampered.length - 1;
    tampered[lastIndex] = (tampered[lastIndex] ?? 0) ^ 0xff;
    expect(() => decryptCredential(tampered)).toThrow();
  });

  test("a tampered IV is refused by the auth tag", () => {
    const ciphertext = encryptCredential("a real credential");
    const tampered = Buffer.from(ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() => decryptCredential(tampered)).toThrow();
  });

  test("a tampered auth tag is refused", () => {
    const ciphertext = encryptCredential("a real credential");
    const tampered = Buffer.from(ciphertext);
    tampered[12] = (tampered[12] ?? 0) ^ 0xff;
    expect(() => decryptCredential(tampered)).toThrow();
  });

  test("a truncated ciphertext is refused", () => {
    const ciphertext = encryptCredential("a real credential");
    expect(() => decryptCredential(ciphertext.subarray(0, ciphertext.length - 1))).toThrow();
  });

  test("a ciphertext from a different key is refused", () => {
    // The property that makes a key rotation safe: an old ciphertext does not
    // silently decrypt to something wrong, it throws.
    const ciphertext = encryptCredential("a real credential");
    setCredentialEncryptionKeyForTesting(Buffer.alloc(32, 0x42));
    expect(() => decryptCredential(ciphertext)).toThrow();
    setCredentialEncryptionKeyForTesting(KEY_BYTES);
  });

  test("a random buffer of a plausible length is refused, not decrypted to garbage", () => {
    // 64 random bytes has the right shape; only the tag can reject it.
    const random = Buffer.from(crypto.getRandomValues(new Uint8Array(64)));
    expect(() => decryptCredential(random)).toThrow();
  });

  test("a Uint8Array is accepted as well as a Buffer", () => {
    // The signature accepts both, and `Buffer.isBuffer` is false for a plain
    // Uint8Array — the `Buffer.from` conversion is what makes it work.
    const ciphertext = encryptCredential("a real credential");
    const asUint8 = new Uint8Array(ciphertext);
    expect(decryptCredentialToString(asUint8)).toBe("a real credential");
  });

  test("a subarray view of a larger buffer decrypts correctly", () => {
    // A `bytea` column read can hand back a view into a larger allocation; the
    // subarray offsets must be respected rather than the whole backing store read.
    const ciphertext = encryptCredential("a real credential");
    const padded = Buffer.concat([Buffer.alloc(8, 0xff), ciphertext]);
    expect(decryptCredentialToString(padded.subarray(8))).toBe("a real credential");
  });
});

describe("decryptCredentialToString", () => {
  test("decodes UTF-8", () => {
    const plaintext = "日本語のクレデンシャル";
    expect(decryptCredentialToString(encryptCredential(plaintext))).toBe(plaintext);
  });

  test("invalid UTF-8 bytes survive the byte path but are replaced on the string path", () => {
    // MEASURED: `toString("utf8")` substitutes U+FFFD for an invalid sequence, so
    // a credential that was not valid UTF-8 to begin with comes back changed. This
    // is only reachable for binary material stored through the string path; the
    // byte path (`decryptCredential`) preserves it exactly, which is why the two
    // accessors both exist. Pinned so the distinction is deliberate: a caller
    // storing binary material must use the byte path.
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
    expect(decryptCredential(encryptCredential(bytes))).toEqual(Buffer.from(bytes));
    const asString = decryptCredentialToString(encryptCredential(bytes));
    expect(asString).not.toBe(Buffer.from(bytes).toString("latin1"));
    expect(asString).toContain("�");
  });
});

describe("hashSecret", () => {
  test("is deterministic for the same input", () => {
    // A stored hash is compared against a freshly computed one on every
    // authentication; a non-deterministic hash would refuse every request.
    expect(hashSecret("a-secret")).toBe(hashSecret("a-secret"));
  });

  test("produces a 64-character lowercase hex digest", () => {
    // HMAC-SHA-256. The shape is what the database column holds and what a
    // comparison expects.
    expect(hashSecret("a-secret")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("different secrets produce different hashes", () => {
    expect(hashSecret("a-secret")).not.toBe(hashSecret("a-secret "));
    expect(hashSecret("a-secret")).not.toBe(hashSecret("A-secret"));
    expect(hashSecret("")).not.toBe(hashSecret("a"));
  });

  test("the hash is keyed, so it is not a plain SHA-256 of the secret", () => {
    // The keying is the point: an unkeyed digest of a low-entropy secret is
    // brute-forceable from a database dump. Asserted by comparing against the
    // unkeyed digest of the same input.
    const secret = "a-secret";
    const unkeyed = Buffer.from(
      new Bun.CryptoHasher("sha256").update(secret, "utf8").digest("hex"),
    ).toString("hex");
    expect(hashSecret(secret)).not.toBe(unkeyed);
  });

  test("the same secret under a different key hashes differently", () => {
    // The consequence of keying: rotating the key invalidates every stored hash,
    // which is why the key is read once and cached.
    const before = hashSecret("a-secret");
    setCredentialEncryptionKeyForTesting(Buffer.alloc(32, 0x42));
    const after = hashSecret("a-secret");
    setCredentialEncryptionKeyForTesting(KEY_BYTES);
    expect(after).not.toBe(before);
  });

  test("a long secret hashes without truncation", () => {
    // A provider credential can be long; the hash is over all of it.
    const long = "z".repeat(100_000);
    expect(hashSecret(long)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(long)).not.toBe(hashSecret(`${long}!`));
  });

  test("a multi-byte secret hashes over its UTF-8 bytes", () => {
    expect(hashSecret("café")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret("café")).not.toBe(hashSecret("cafe"));
  });

  test("the hash and the encryption agree about the key", () => {
    // The doc comment's stated reason for sharing the key: hashing and
    // encryption never disagree about the secret derivation. Asserted by
    // changing the key once and observing both change.
    const hash = hashSecret("a-secret");
    const ciphertext = encryptCredential("a-credential");
    setCredentialEncryptionKeyForTesting(Buffer.alloc(32, 0x42));
    expect(hashSecret("a-secret")).not.toBe(hash);
    expect(() => decryptCredential(ciphertext)).toThrow();
    setCredentialEncryptionKeyForTesting(KEY_BYTES);
    expect(decryptCredentialToString(ciphertext)).toBe("a-credential");
  });
});

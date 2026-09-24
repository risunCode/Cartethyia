import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  decryptCredential,
  decryptCredentialToString,
  encryptCredential,
  getCredentialEncryptionKey,
  hashSecret,
  setCredentialEncryptionKeyForTesting,
} from "../../src/security/crypto";

describe("credential encryption", () => {
  beforeEach(() => {
    setCredentialEncryptionKeyForTesting(Buffer.alloc(32, 7));
  });

  afterEach(() => {
    setCredentialEncryptionKeyForTesting(undefined);
  });

  test("round-trips a string secret", () => {
    const ciphertext = encryptCredential("provider-secret");
    expect(decryptCredentialToString(ciphertext)).toBe("provider-secret");
  });

  test("round-trips binary input", () => {
    const plaintext = Buffer.from([0, 1, 2, 255]);
    expect(decryptCredential(encryptCredential(plaintext))).toEqual(plaintext);
  });

  test("produces a fresh randomized ciphertext per call", () => {
    expect(encryptCredential("same")).not.toEqual(encryptCredential("same"));
  });

  test("rejects truncated ciphertext", () => {
    expect(() => decryptCredential(Buffer.alloc(4))).toThrow();
  });

  test("rejects tampered ciphertext", () => {
    const ciphertext = encryptCredential("provider-secret");
    const last = ciphertext.length - 1;
    ciphertext[last] = (ciphertext[last] ?? 0) ^ 1;
    expect(() => decryptCredential(ciphertext)).toThrow();
  });

  test("rejects decryption under a different key", () => {
    const ciphertext = encryptCredential("provider-secret");
    setCredentialEncryptionKeyForTesting(Buffer.alloc(32, 8));
    expect(() => decryptCredential(ciphertext)).toThrow();
  });

  test("fails closed without an encryption key", () => {
    setCredentialEncryptionKeyForTesting(undefined);
    const previous = process.env.CARTETHYIA_ENCRYPTION_KEY;
    delete process.env.CARTETHYIA_ENCRYPTION_KEY;
    try {
      expect(() => getCredentialEncryptionKey()).toThrow();
    } finally {
      if (previous !== undefined) process.env.CARTETHYIA_ENCRYPTION_KEY = previous;
      setCredentialEncryptionKeyForTesting(Buffer.alloc(32, 7));
    }
  });
});

describe("hashSecret", () => {
  afterEach(() => {
    setCredentialEncryptionKeyForTesting(undefined);
  });

  test("requires the encryption key", () => {
    setCredentialEncryptionKeyForTesting(undefined);
    const previous = process.env.CARTETHYIA_ENCRYPTION_KEY;
    delete process.env.CARTETHYIA_ENCRYPTION_KEY;
    try {
      expect(() => hashSecret("bearer-token")).toThrow(
        "CARTETHYIA_ENCRYPTION_KEY is required",
      );
    } finally {
      if (previous !== undefined) process.env.CARTETHYIA_ENCRYPTION_KEY = previous;
    }
  });

  test("uses HMAC-SHA-256 with the decoded 256-bit key", () => {
    const key = Buffer.alloc(32, 7);
    setCredentialEncryptionKeyForTesting(key);
    const expected = createHmac("sha256", key)
      .update("bearer-token", "utf8")
      .digest("hex");
    expect(hashSecret("bearer-token")).toBe(expected);
  });

  test("digest is deterministic for a fixed key and changes when the key changes", () => {
    setCredentialEncryptionKeyForTesting(Buffer.alloc(32, 1));
    const first = hashSecret("bearer-token");
    expect(hashSecret("bearer-token")).toBe(first);
    setCredentialEncryptionKeyForTesting(Buffer.alloc(32, 2));
    expect(hashSecret("bearer-token")).not.toBe(first);
  });
});

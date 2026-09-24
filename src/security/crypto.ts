// Credential encryption (AES-256-GCM) and secret hashing. Postgres never sees plaintext.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { decodeEncryptionKey, requireEncryptionKeyEnv } from "../config";

/**
 * Application-layer AES-256-GCM credential encryption for upstream provider
 * credentials. Postgres never sees plaintext: `provider_accounts`
 * stores only the ciphertext produced here in its `bytea` columns.
 *
 * AES-256-GCM. Encoded buffer layout: `iv(12) || authTag(16) || ciphertext`.
 * The key is a 32-byte secret read from `CARTETHYIA_ENCRYPTION_KEY`
 * (base64 or hex encoded); it is never inferred or defaulted.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

let cachedKey: Buffer | undefined;


/**
 * Resolves the credential encryption key from the environment. Throws when
 * the variable is absent — there is no silent fallback to a fixed/derived
 * key, matching the fail-closed posture required for credential storage.
 */
export function getCredentialEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = decodeEncryptionKey(requireEncryptionKeyEnv());
  return cachedKey;
}

/** Test-only override; production code must never call this. */
export function setCredentialEncryptionKeyForTesting(key: Buffer | undefined): void {
  cachedKey = key;
}

/** Encrypts plaintext credential material (e.g. a raw API key) for storage. */
export function encryptCredential(plaintext: string | Uint8Array): Buffer {
  const key = getCredentialEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const input =
    typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/** Decrypts a buffer produced by {@link encryptCredential}. */
export function decryptCredential(encoded: Buffer | Uint8Array): Buffer {
  const key = getCredentialEncryptionKey();
  const buf = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("malformed credential ciphertext: too short");
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Decrypts credential ciphertext directly to a UTF-8 string. */
export function decryptCredentialToString(encoded: Buffer | Uint8Array): string {
  return decryptCredential(encoded).toString("utf8");
}

/**
 * One-way hash contract for credential/key material. Uses the same decoded
 * 256-bit key as {@link encryptCredential} so hashing and encryption never
 * disagree about the secret derivation; the key is read once and cached.
 */
export function hashSecret(secret: string): string {
  return createHmac("sha256", getCredentialEncryptionKey()).update(secret, "utf8").digest("hex");
}

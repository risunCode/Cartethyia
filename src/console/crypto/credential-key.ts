/**
 * Credential encryption — AES-256-GCM via WebCrypto.
 *
 * Key resolution order:
 *   1. CREDENTIAL_ENCRYPTION_KEY (base64, 32 bytes)
 *   2. CREDENTIAL_ENCRYPTION_KEY_FILE (generated once, mode 0600)
 *
 * Storage format: "v1." + base64(iv ‖ ciphertext+tag)
 */

import { getConsoleEnv } from "../env";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const VERSION_PREFIX = "v1.";

let cachedKey: CryptoKey | null = null;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(input: string): Uint8Array<ArrayBuffer> {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function loadKeyBytes(): Promise<Uint8Array<ArrayBuffer>> {
  const env = getConsoleEnv();
  if (env.credentialKey) {
    const raw = fromBase64(env.credentialKey);
    if (raw.length !== 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes");
    return raw;
  }
  const file = Bun.file(env.credentialKeyFile);
  if (await file.exists()) {
    const raw = fromBase64((await file.text()).trim());
    if (raw.length !== 32) throw new Error("credential key file is corrupt");
    return raw;
  }
  const generated = crypto.getRandomValues(new Uint8Array(32));
  mkdirSync(dirname(env.credentialKeyFile), { recursive: true });
  writeFileSync(env.credentialKeyFile, toBase64(generated), { mode: 0o600 });
  try {
    chmodSync(env.credentialKeyFile, 0o600);
  } catch {
    // best effort on platforms without chmod
  }
  return generated;
}

export async function getCredentialKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    const raw = await loadKeyBytes();
    cachedKey = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }
  return cachedKey;
}

export async function encryptCredential(plaintext: string): Promise<string> {
  const key = await getCredentialKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)));
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return VERSION_PREFIX + toBase64(packed);
}

export async function decryptCredential(stored: string): Promise<string> {
  if (!stored.startsWith(VERSION_PREFIX)) throw new Error("unsupported credential format");
  const key = await getCredentialKey();
  const packed = fromBase64(stored.slice(VERSION_PREFIX.length));
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return decoder.decode(plain);
}

/** Masked display hint: last 4 chars only. */
export function credentialHint(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return `…${tail}`;
}

/**
 * Rotate the on-disk credential key: generate fresh bytes, overwrite the key
 * file (mode 0600) and drop the cached CryptoKey so the next operation loads
 * the new key. Throws when the key is env-managed (CREDENTIAL_ENCRYPTION_KEY),
 * because rotation cannot touch the environment.
 */
export async function rotateCredentialKeyFile(): Promise<void> {
  const env = getConsoleEnv();
  if (env.credentialKey) throw new Error("credential key is env-managed; rotation is disabled");
  const generated = crypto.getRandomValues(new Uint8Array(32));
  mkdirSync(dirname(env.credentialKeyFile), { recursive: true });
  writeFileSync(env.credentialKeyFile, toBase64(generated), { mode: 0o600 });
  try {
    chmodSync(env.credentialKeyFile, 0o600);
  } catch {
    // best effort on platforms without chmod
  }
  cachedKey = null;
}

/** Test-only: drop the cached key so env/file changes take effect. */
export function resetCredentialKeyForTests(): void {
  cachedKey = null;
}

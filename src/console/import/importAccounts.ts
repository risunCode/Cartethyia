import { getDb } from "../db/client";
import { createAccount, type CredentialKind } from "../db/repos/accounts";
import { accountCredentialKindOf, isProviderId } from "../../routing/providerMeta";
import { scheduleGlobalGc } from "../memory";

interface ImportLine { line: number; text: string; }
interface ParsedCredential { line: number; credential: string; }
interface SkippedLine { line: number; reason: string; }
interface WorkerResult { valid: ParsedCredential[]; skipped: SkippedLine[]; }

export interface AccountImportSummary {
  imported: number;
  skipped: SkippedLine[];
  renamed: Array<{ line: number; name: string }>;
}

const CHUNK_SIZE = 200;

function parseChunk(lines: ImportLine[], provider: string): Promise<WorkerResult> {
  const { promise, resolve, reject } = Promise.withResolvers<WorkerResult>();
  const worker = new Worker(new URL("./accountImportWorker.ts", import.meta.url).href);
  worker.onmessage = (event: MessageEvent<WorkerResult>) => {
    worker.terminate();
    resolve(event.data);
  };
  worker.onerror = (event) => {
    worker.terminate();
    reject(event.error ?? new Error(event.message));
  };
  worker.postMessage({ lines, provider });
  return promise;
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base} (${suffix})`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Parses pasted account exports in workers and inserts valid accounts atomically per batch. */
export async function importAccountsForProvider(provider: string, text: string): Promise<AccountImportSummary> {
  if (!isProviderId(provider)) throw new Error(`Unsupported provider: ${provider}`);
  const lines = text.split(/\r?\n/).map((line, index) => ({ line: index + 1, text: line }));
  const chunks = Array.from({ length: Math.ceil(lines.length / CHUNK_SIZE) }, (_, index) => lines.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
  const results = await Promise.all(chunks.map((chunk) => parseChunk(chunk, provider)));
  const skipped = results.flatMap((result) => result.skipped);
  const parsed = results.flatMap((result) => result.valid);
  const db = getDb();
  const used = new Set((db.query("SELECT name FROM provider_accounts WHERE provider = ?").all(provider) as Array<{ name: string }>).map((row) => row.name));
  const credentialKind: CredentialKind = accountCredentialKindOf(provider);
  const renamed: Array<{ line: number; name: string }> = [];

  db.transaction(() => {
    for (const entry of parsed) {
      const base = `Imported ${entry.line}`;
      const name = uniqueName(base, used);
      used.add(name);
      if (name !== base) renamed.push({ line: entry.line, name });
      createAccount({ provider, name, credentialKind, credential: entry.credential });
    }
  })();
  scheduleGlobalGc();
  return { imported: parsed.length, skipped, renamed };
}

import { extractCredentialFromPaste } from "../../shared/credentialExtract";
import { importOAuthCredential, type OAuthImportProvider } from "../../shared/oauthImport";

declare const self: {
  onmessage: ((event: MessageEvent<ImportWorkerRequest>) => void) | null;
};

interface ImportLine { line: number; text: string; }
interface ImportWorkerRequest { lines: ImportLine[]; provider?: string; }
interface ParsedCredential { line: number; credential: string; extracted: boolean; source?: string; }
interface SkippedLine { line: number; reason: string; }

self.onmessage = (event: MessageEvent<ImportWorkerRequest>) => {
  const valid: ParsedCredential[] = [];
  const skipped: SkippedLine[] = [];
  for (const entry of event.data.lines) {
    const trimmed = entry.text.trim();
    if (!trimmed) {
      skipped.push({ line: entry.line, reason: "blank line" });
      continue;
    }
    if (event.data.provider === "openai-codex" || event.data.provider === "anthropic-oauth" || event.data.provider === "cline" || event.data.provider === "grok-cli" || event.data.provider === "google-antigravity") {
      const imported = importOAuthCredential(event.data.provider as OAuthImportProvider, trimmed);
      if (!imported.ok) {
        skipped.push({ line: entry.line, reason: imported.reason });
        continue;
      }
      valid.push({ line: entry.line, credential: imported.credential, extracted: true, source: "oauth-json" });
      continue;
    }
    const extracted = extractCredentialFromPaste(trimmed);
    if (!extracted.value) {
      skipped.push({ line: entry.line, reason: "credential is empty" });
      continue;
    }
    valid.push({ line: entry.line, credential: extracted.value, extracted: extracted.extracted, source: extracted.source });
  }
  postMessage({ valid, skipped });
};

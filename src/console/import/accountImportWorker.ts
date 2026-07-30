import { extractCredentialFromPaste } from "../../shared/credentialExtract";

declare const self: {
  onmessage: ((event: MessageEvent<ImportWorkerRequest>) => void) | null;
};

interface ImportLine { line: number; text: string; }
interface ImportWorkerRequest { lines: ImportLine[]; }
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
    const extracted = extractCredentialFromPaste(trimmed);
    if (!extracted.value) {
      skipped.push({ line: entry.line, reason: "credential is empty" });
      continue;
    }
    valid.push({ line: entry.line, credential: extracted.value, extracted: extracted.extracted, source: extracted.source });
  }
  postMessage({ valid, skipped });
};

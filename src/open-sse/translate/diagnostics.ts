import type { Surface, TranslationDiagnostic, TranslationDiagnosticAction, TranslationDiagnosticStage, ProxyEndpoint } from "../../application/contracts";
import type { FormatDetectionResult } from "./detection";

const MAX_DIAGNOSTICS = 32;
const MAX_VALUE_LENGTH = 160;
const SAFE_FORMATS = new Set(["openai-chat", "openai-responses", "anthropic-messages", "cursor-chat-hybrid", "gemini", "gemini-cli", "codex", "unknown"]);

export interface TranslationDiagnosticInput {
  readonly stage: TranslationDiagnosticStage;
  readonly sourceFormat: string;
  readonly targetSurface: Surface;
  readonly fieldCategory: string;
  readonly action: TranslationDiagnosticAction;
  readonly reason: string;
}

/** Builds bounded, allowlisted metadata; payload values are never accepted as diagnostics. */
export function boundedTranslationDiagnostics(inputs: readonly TranslationDiagnosticInput[]): readonly TranslationDiagnostic[] {
  const seen = new Set<string>();
  const diagnostics: TranslationDiagnostic[] = [];
  for (const input of inputs) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) break;
    const diagnostic: TranslationDiagnostic = {
      stage: input.stage,
      sourceFormat: SAFE_FORMATS.has(input.sourceFormat) ? input.sourceFormat : "unknown",
      targetSurface: input.targetSurface,
      fieldCategory: clamp(input.fieldCategory, 64),
      action: input.action,
      reason: sanitizeReason(input.reason),
    };
    const key = `${diagnostic.stage}|${diagnostic.sourceFormat}|${diagnostic.targetSurface}|${diagnostic.fieldCategory}|${diagnostic.action}|${diagnostic.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

/** Records only protocol adaptation signals; headers, payloads, and identities are excluded. */
export function diagnosticsForDetection(
  endpoint: ProxyEndpoint,
  targetSurface: Surface,
  detection: FormatDetectionResult,
  normalizedEndpoint: ProxyEndpoint,
): readonly TranslationDiagnostic[] {
  const inputs: TranslationDiagnosticInput[] = [];
  if (endpoint !== normalizedEndpoint) {
    inputs.push({
      stage: "normalization",
      sourceFormat: detection.profile.format,
      targetSurface,
      fieldCategory: "wire-surface",
      action: "adapted",
      reason: `body shape selected ${normalizedEndpoint} codec`,
    });
  }
  for (const conflict of detection.conflicts.slice(0, 8)) {
    inputs.push({
      stage: "detection",
      sourceFormat: detection.profile.format,
      targetSurface,
      fieldCategory: "client-format",
      action: "adapted",
      reason: conflict,
    });
  }
  return boundedTranslationDiagnostics(inputs);
}

function sanitizeReason(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (/[{}\[\]]/.test(normalized)) return "redacted structured detail";
  return clamp(normalized
    .replace(/\bbearer\s+\S+/gi, "bearer [redacted]")
    .replace(/\b(?:authorization|api[-_]?key|secret|password|token)\b\s*[:=]\s*\S+/gi, "$1 [redacted]"), MAX_VALUE_LENGTH);
}

function clamp(value: string, limit: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

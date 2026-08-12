import type { ProviderCallError, Surface, TranslationDiagnostic } from "../../application/contracts";
import type { ClientFormat, ClientProfile } from "./detection";
import type { ModelCapabilities } from "./capabilities";
import type { FieldDisposition } from "./request/document";

export interface TranslationPolicy {
  readonly preserveExtensions: boolean;
  readonly retryOptionalCompatibility: boolean;
  readonly emitDiagnostics: boolean;
}

export interface TranslationDiagnosticSink {
  record(diagnostic: TranslationDiagnostic): void;
}

export interface TranslationContext {
  readonly source: {
    readonly client: ClientProfile;
    readonly format: ClientFormat;
    readonly surface: Surface;
  };
  readonly target: {
    readonly providerId: string;
    readonly modelId: string;
    readonly upstreamModelId: string;
    readonly surface: Surface;
    readonly capabilities: ModelCapabilities;
  };
  readonly policy: TranslationPolicy;
  readonly diagnostics: TranslationDiagnosticSink;
}

export interface FeatureTranslation<T> {
  readonly value: T;
  readonly dispositions: readonly FieldDisposition[];
  readonly diagnostics: readonly TranslationDiagnostic[];
}

export interface CompatibilityRejection {
  readonly category: "unsupported-field" | "unsupported-cache" | "unsupported-reasoning" | "unsupported-tool" | "unsupported-response";
  readonly fieldPath: string;
  readonly optional: boolean;
  readonly retryable: boolean;
}

export interface CompatibilityRule {
  match(error: ProviderCallError): CompatibilityRejection | null;
  remove(payload: Record<string, unknown>, rejection: CompatibilityRejection): void;
}

export function createTranslationContext(input: Omit<TranslationContext, "policy"> & { readonly policy?: Partial<TranslationPolicy> }): TranslationContext {
  return {
    ...input,
    policy: {
      preserveExtensions: input.policy?.preserveExtensions ?? true,
      retryOptionalCompatibility: input.policy?.retryOptionalCompatibility ?? true,
      emitDiagnostics: input.policy?.emitDiagnostics ?? true,
    },
  };
}

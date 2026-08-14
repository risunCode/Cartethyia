import type { CredentialKind, Surface } from "../../application/contracts";
// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Enabled/config state for a registered provider. */
export interface ProviderConfigView {
  readonly id: string;
  readonly enabled: boolean;
}

export interface ProviderRoutingSettings {
  readonly strategy: "priority" | "round-robin";
  readonly stickyLimit: number;
  readonly useStickyLimit: boolean;
}

export interface ProviderConfigRepository {
  list(): Promise<readonly ProviderConfigView[]>;
  get(id: string): Promise<ProviderConfigView | null>;
  setEnabled(id: string, enabled: boolean): Promise<ProviderConfigView | null>;
  getRouting(id: string): Promise<ProviderRoutingSettings>;
  setRouting(id: string, patch: Partial<ProviderRoutingSettings>): Promise<ProviderRoutingSettings>;
}

export type CustomProviderKind = "openai" | "anthropic" | "openai-compatible";

/** Custom provider row — never carries the credential in views. */
export interface CustomProviderView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly kind: CustomProviderKind;
  readonly baseUrl: string;
  readonly credentialHint: string;
  readonly timeoutSeconds: number;
  readonly autoFetchModels: boolean;
  readonly customHeaders: Readonly<Record<string, string>>;
  readonly models: readonly unknown[];
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomProviderCreateInput {
  readonly name: string;
  readonly kind: CustomProviderKind;
  readonly slug: string;
  readonly baseUrl: string;
  readonly credential?: string;
  readonly timeoutSeconds?: number;
  readonly autoFetchModels?: boolean;
  readonly customHeaders?: Readonly<Record<string, string>>;
}

export interface CustomProviderUpdateInput {
  readonly name?: string;
  readonly kind?: CustomProviderKind;
  readonly slug?: string;
  readonly baseUrl?: string;
  readonly credential?: string;
  readonly timeoutSeconds?: number;
  readonly autoFetchModels?: boolean;
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly enabled?: boolean;
}

export interface CustomProviderRepository {
  list(): Promise<readonly CustomProviderView[]>;
  get(id: string): Promise<CustomProviderView | null>;
  create(input: CustomProviderCreateInput): Promise<CustomProviderView | { readonly error: "duplicate" }>;
  update(id: string, patch: CustomProviderUpdateInput): Promise<CustomProviderView | null>;
  remove(id: string): Promise<boolean>;
  updateModels(id: string, models: readonly unknown[]): Promise<CustomProviderView | null>;
  /** Explicit credential endpoint contract. */
  credential(id: string): Promise<{ readonly credential: string } | null>;
}

/** Interactive OAuth entry points exposed by a provider's registered driver. */
export interface ProviderOAuthFlows {
  readonly browser: boolean;
  readonly device: boolean;
}

/** Built-in provider with its config state, as shown in console lists. */
export interface ProviderSummaryView {
  readonly id: string;
  readonly name: string;
  readonly protocol: string;
  readonly credentialKind: CredentialKind;
  readonly credentialKinds: readonly CredentialKind[];
  readonly credentialUrl: string | null;
  readonly surfaces: readonly Surface[];
  readonly enabled: boolean;
  readonly custom: boolean;
  readonly oauthFlows: ProviderOAuthFlows;
}

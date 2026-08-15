import type { ResolvedModelMetadata } from "../../application/model-metadata";
// ---------------------------------------------------------------------------
// Aliases and combos
// ---------------------------------------------------------------------------

export interface AliasView {
  readonly alias: string;
  readonly model: string;
  readonly createdAt: string;
  /** Resolved metadata of the alias target; absent when unresolvable. */
  readonly metadata?: ResolvedModelMetadata;
}

export interface ComboView {
  readonly id: string;
  readonly name: string;
  readonly models: readonly string[];
  readonly strategy: "fallback" | "round-robin";
  readonly stickyLimit: number;
  /** Aggregated metadata of combo members; absent when unresolvable. */
  readonly metadata?: ResolvedModelMetadata;
}

export interface ComboInput {
  readonly name: string;
  readonly models: readonly string[];
  readonly strategy: "fallback" | "round-robin";
  readonly stickyLimit: number;
}

export interface RoutingConfigRepository {
  listAliases(): Promise<readonly AliasView[]>;
  putAlias(alias: string, model: string): Promise<AliasView>;
  deleteAlias(alias: string): Promise<boolean>;
  listCombos(): Promise<readonly ComboView[]>;
  getCombo(id: string): Promise<ComboView | null>;
  putCombo(input: ComboInput): Promise<ComboView>;
  deleteCombo(id: string): Promise<boolean>;
}


// ---------------------------------------------------------------------------
// Filter rules — pre-request content sanitizer patterns
// ---------------------------------------------------------------------------

export interface FilterRuleView {
  readonly id: number;
  readonly ruleId: string;
  readonly pattern: string;
  readonly replacement: string;
  readonly isActive: boolean;
  readonly isRegex: boolean;
  readonly sortOrder: number;
}

export interface FilterRuleInput {
  readonly ruleId?: string;
  readonly pattern: string;
  readonly replacement?: string;
  readonly isRegex?: boolean;
  readonly isActive?: boolean;
}

export interface FilterRulePatch {
  readonly pattern?: string;
  readonly replacement?: string;
  readonly isRegex?: boolean;
  readonly isActive?: boolean;
  readonly sortOrder?: number;
}

export interface FilterRuleRepository {
  list(): Promise<readonly FilterRuleView[]>;
  listSync(): readonly FilterRuleView[];
  create(input: FilterRuleInput): Promise<FilterRuleView>;
  update(id: number, patch: FilterRulePatch): Promise<FilterRuleView | null>;
  remove(id: number): Promise<boolean>;
}
// IP bans
// ---------------------------------------------------------------------------

export interface IpBanView {
  readonly ip: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface IpBanRepository {
  list(): Promise<readonly IpBanView[]>;
  add(ip: string, reason?: string): Promise<IpBanView>;
  remove(ip: string): Promise<boolean>;
  isBanned(ip: string): Promise<boolean>;
  bannedSet(): Promise<ReadonlySet<string>>;
}

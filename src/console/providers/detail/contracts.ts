import type { ConsoleAccessResolver } from "../../auth/access";
import type { AuditSink } from "../../domains/audit/contracts";
import type { ProviderRoutingResponse, UpdateProviderRoutingRequest } from "../catalog/contracts";

export interface AccountInflightReading {
  readonly accountId: string;
  readonly inflight: number;
}

export interface ProviderDetailStore {
  getRouting(providerId: string, tenantId: string | null): Promise<ProviderRoutingResponse>;
  updateRouting(
    providerId: string,
    tenantId: string | null,
    patch: UpdateProviderRoutingRequest,
  ): Promise<ProviderRoutingResponse>;
}



export interface ProviderDetailConfig {
  readonly store: ProviderDetailStore;
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
  readonly snapshotInvalidator?: { invalidate(): Promise<number> };
  /** Optional live admission read port; absent means inflight is unavailable. */
  readonly accountInflight?:
    | ((
        providerId: string,
        tenantId: string | null,
      ) => Promise<readonly AccountInflightReading[]>)
    | undefined;
}


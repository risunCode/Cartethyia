import type { ConsoleAccessResolver } from "../../auth/access";
import type { AuditSink } from "../../domains/audit/contracts";
import type { ProviderRoutingResponse, UpdateProviderRoutingRequest } from "../catalog/contracts";

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
}


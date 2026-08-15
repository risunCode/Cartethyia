import type { Surface } from "../../../application/contracts";
import type { ClientProfile } from "../detection";

export interface NativePassthroughContext {
  readonly client: ClientProfile;
  readonly source: Surface;
  readonly target: Surface;
  readonly providerAllowsNative: boolean;
}

/** Allows native passthrough only for explicit same-protocol, capability-approved clients. */
export function isNativePassthroughEligible(context: NativePassthroughContext): boolean {
  return context.providerAllowsNative
    && context.client.passthrough !== "never"
    && context.source === context.target
    && (context.source === "anthropic-messages" || context.source === "openai-chat" || context.source === "openai-responses")
    && context.client.format === context.source;
}

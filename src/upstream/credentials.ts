import type { RouteTarget } from "../routing/types";
import type { ResolvedCredential } from "./providers/index";

export interface InboundHeaders {
  authorization?: string;
  "x-api-key"?: string;
}

function extractBearer(headers: InboundHeaders): string | undefined {
  if (headers.authorization?.startsWith("Bearer ")) return headers.authorization.slice(7);
  return undefined;
}

export function resolveCredential(target: RouteTarget, headers: InboundHeaders): ResolvedCredential | undefined {
  if (target.credential === "none") return { kind: "none", value: "" };

  if (target.credential === "provider-bearer") {
    const value = extractBearer(headers);
    if (!value) return undefined;
    return { kind: "provider-bearer", value };
  }

  if (target.credential === "devin-session") {
    const value = extractBearer(headers);
    if (!value) return undefined;
    return { kind: "devin-session", value };
  }

  if (target.credential === "qoder-pat") {
    const value = extractBearer(headers);
    if (!value) return undefined;
    return { kind: "qoder-pat", value };
  }

  return undefined;
}

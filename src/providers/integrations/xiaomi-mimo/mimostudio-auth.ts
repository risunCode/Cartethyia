import { GatewayError } from "../../../transport/gateway-error";

export const MIMO_STUDIO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface MimoStudioCredentials {
  readonly serviceToken: string;
  readonly userId: string;
  readonly phToken: string;
}

function cleanQuotedValue(val: string): string {
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function parseMimoStudioCredential(raw: string): MimoStudioCredentials {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new GatewayError("invalid_request", 400, "MiMo Studio credential cannot be empty");
  }

  // 1. JSON parsing: supports flat object, { xiaomi: ... }, or Cookie-Editor / SessionBox export array
  try {
    const parsed = JSON.parse(trimmed) as unknown;

    // 1A. Array format: Cookie-Editor, EditThisCookie, or SessionBox export
    // Example: [{ cookies: [{ name: "xiaomichatbot_serviceToken", value: "..." }, ...] }]
    // Or flat cookie array: [{ name: "serviceToken", value: "..." }, ...]
    if (Array.isArray(parsed) && parsed.length > 0) {
      let cookieItems: unknown[] = [];
      const first = parsed[0] as unknown;
      if (first && typeof first === "object") {
        if ("cookies" in first && Array.isArray((first as { cookies: unknown }).cookies)) {
          cookieItems = (first as { cookies: unknown[] }).cookies;
        } else if ("name" in first && "value" in first) {
          cookieItems = parsed;
        }
      }

      let st = "";
      let uid = "";
      let ph = "";

      for (const item of cookieItems) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const name = typeof record["name"] === "string" ? record["name"] : "";
        const val = typeof record["value"] === "string" ? record["value"] : "";
        if (!name || !val) continue;

        if (name === "xiaomichatbot_serviceToken" || name === "serviceToken") {
          st = cleanQuotedValue(val);
        } else if (name === "userId") {
          uid = cleanQuotedValue(val);
        } else if (name === "xiaomichatbot_ph") {
          ph = cleanQuotedValue(val);
        }
      }

      if (st && uid) {
        return {
          serviceToken: st,
          userId: uid,
          phToken: ph,
        };
      }
    }

    // 1B. Standard JSON object format
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const target = (obj["xiaomi"] && typeof obj["xiaomi"] === "object" && !Array.isArray(obj["xiaomi"])
        ? (obj["xiaomi"] as Record<string, unknown>)
        : obj);

      const st =
        typeof target["service_token"] === "string"
          ? target["service_token"]
          : typeof target["serviceToken"] === "string"
            ? target["serviceToken"]
            : typeof target["xiaomichatbot_serviceToken"] === "string"
              ? target["xiaomichatbot_serviceToken"]
              : "";
      const uid =
        typeof target["user_id"] === "string" || typeof target["user_id"] === "number"
          ? String(target["user_id"])
          : typeof target["userId"] === "string" || typeof target["userId"] === "number"
            ? String(target["userId"])
            : "";
      const ph =
        typeof target["ph_token"] === "string"
          ? target["ph_token"]
          : typeof target["phToken"] === "string"
            ? target["phToken"]
            : typeof target["xiaomichatbot_ph"] === "string"
              ? target["xiaomichatbot_ph"]
              : "";

      if (st && uid) {
        return {
          serviceToken: cleanQuotedValue(st),
          userId: cleanQuotedValue(uid),
          phToken: cleanQuotedValue(ph),
        };
      }
    }
  } catch {
    // Continue with cURL / Cookie string parsing
  }

  // 2. cURL or raw Cookie line format
  let cookies = trimmed;
  const cookieMatch =
    trimmed.match(/-H\s+['"]Cookie:\s*([^'"]+)['"]/i) ||
    trimmed.match(/--header\s+['"]Cookie:\s*([^'"]+)['"]/i) ||
    trimmed.match(/Cookie:\s*([^\r\n]+)/i);

  if (cookieMatch && cookieMatch[1]) {
    cookies = cookieMatch[1];
  }

  const stMatch =
    cookies.match(/xiaomichatbot_serviceToken=["']?([^"';\s]+)["']?/) ||
    cookies.match(/serviceToken=["']?([^"';\s]+)["']?/);
  const uidMatch = cookies.match(/userId=["']?([^"';\s]+)["']?/);
  let phMatch = cookies.match(/xiaomichatbot_ph=["']?([^"';\s]+)["']?/);

  if (!phMatch) {
    const urlPh = trimmed.match(/[?&]xiaomichatbot_ph=([^&'"\s\\]+)/);
    if (urlPh && urlPh[1]) {
      try {
        phMatch = [urlPh[0], decodeURIComponent(urlPh[1])];
      } catch {
        phMatch = urlPh;
      }
    }
  }

  if (stMatch && stMatch[1] && uidMatch && uidMatch[1]) {
    return {
      serviceToken: cleanQuotedValue(stMatch[1]),
      userId: cleanQuotedValue(uidMatch[1]),
      phToken: cleanQuotedValue(phMatch && phMatch[1] ? phMatch[1] : ""),
    };
  }

  throw new GatewayError(
    "invalid_request",
    400,
    "Invalid MiMo Studio credential. Provide JSON with serviceToken & userId, Cookie-Editor/SessionBox export JSON, or paste cURL containing serviceToken and userId cookies.",
  );
}

export function encodeMimoStudioCredential(creds: MimoStudioCredentials): string {
  return JSON.stringify(creds);
}

export function buildMimoStudioCookieHeader(creds: MimoStudioCredentials): string {
  const parts = [
    `serviceToken=${creds.serviceToken}`,
    `xiaomichatbot_serviceToken="${creds.serviceToken}"`,
    `xiaomichatbot_serviceToken=${creds.serviceToken}`,
    `userId=${creds.userId}`,
  ];
  if (creds.phToken) {
    parts.push(`xiaomichatbot_ph="${creds.phToken}"`);
    parts.push(`xiaomichatbot_ph=${creds.phToken}`);
  }
  return parts.join("; ");
}

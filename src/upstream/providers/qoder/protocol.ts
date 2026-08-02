import { createCipheriv, createHash, constants, publicEncrypt, randomUUID } from "node:crypto";

import { ProviderCallError } from "../index";

const APPCODE = "cosy";
const COSY_VERSION = "1.0.22";
const SIG_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==";
const QODER_JOB_TOKEN_URL = "https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1";
export const QODER_MODEL_LIST_URL = "https://api3.qoder.sh/algo/api/v2/model/list";
export const QODER_CHAT_URL = "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

const STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const QODER_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export interface QoderAuth {
  userId: string;
  userName: string;
  userType: string;
  securityOauthToken: string;
  refreshToken: string;
  machineId: string;
}

interface JobTokenResponse {
  id?: string;
  name?: string;
  securityOauthToken?: string;
  refreshToken?: string;
  userType?: string;
}

/** Encodes a Qoder body using the CLI's request encoding. */
export function encodeQoderBody(plaintext: string): Uint8Array {
  const base64 = Buffer.from(plaintext).toString("base64");
  const third = Math.floor(base64.length / 3);
  const reordered = base64.slice(base64.length - third) + base64.slice(third, base64.length - third) + base64.slice(0, third);
  let encoded = "";
  for (const char of reordered) {
    if (char === "=") encoded += "$";
    else encoded += QODER_ALPHABET[STANDARD_ALPHABET.indexOf(char)] ?? char;
  }
  return Buffer.from(encoded, "latin1");
}

const MACHINE_ID_TTL_MS = 60 * 60 * 1000;
const MAX_MACHINE_IDS = 1_024;
const machineIds = new Map<string, { id: string; expiresAt: number }>();

/** Keeps a request-local PAT's ephemeral client identity stable without retaining the PAT itself. */
function machineIdFromPat(pat: string): string {
  const key = createHash("sha256").update(pat).digest("hex");
  const now = Date.now();
  const existing = machineIds.get(key);
  if (existing && existing.expiresAt > now) return existing.id;

  const id = randomUUID();
  machineIds.delete(key);
  machineIds.set(key, { id, expiresAt: now + MACHINE_ID_TTL_MS });
  for (const [candidate, value] of machineIds) {
    if (value.expiresAt <= now) machineIds.delete(candidate);
  }
  while (machineIds.size > MAX_MACHINE_IDS) {
    const oldest = machineIds.keys().next();
    if (oldest.done) break;
    machineIds.delete(oldest.value);
  }
  return id;
}

function md5(value: string | Uint8Array): string {
  return createHash("md5").update(value).digest("hex");
}

function pathSignature(url: string): string {
  const path = new URL(url).pathname;
  return path.startsWith("/algo") ? path.slice(5) : path;
}

function staticHeaders(machineId: string): Record<string, string> {
  const date = new Date().toUTCString();
  return {
    "cosy-machinetoken": machineId,
    "cosy-machinetype": "5",
    "cosy-machineid": machineId,
    "cosy-clienttype": "5",
    "cosy-version": COSY_VERSION,
    "login-version": "v2",
    appcode: APPCODE,
    accept: "application/json",
    "accept-encoding": "identity",
    date,
    signature: md5(`${APPCODE}&${SIG_SECRET}&${date}`),
    "content-type": "application/json",
    "user-agent": "Go-http-client/2.0",
  };
}

/** Exchanges an inbound Qoder personal access token for request-local signing credentials. */
export async function exchangeQoderPat(pat: string, signal: AbortSignal): Promise<QoderAuth> {
  const machineId = machineIdFromPat(pat);
  const body = encodeQoderBody(JSON.stringify({
    payload: JSON.stringify({ personalToken: pat, securityOauthToken: "", refreshToken: "", needRefresh: false, authInfo: {} }),
    encodeVersion: "1",
  }));
  const response = await fetch(QODER_JOB_TOKEN_URL, { method: "POST", headers: staticHeaders(machineId), body, signal });
  if (!response.ok) throw qoderHttpError(response.status, "PAT exchange");
  const result = await response.json() as JobTokenResponse;
  if (!result.id || !result.securityOauthToken) throw new Error("Qoder PAT exchange returned incomplete credentials.");
  return {
    userId: result.id,
    userName: result.name ?? "",
    userType: result.userType ?? "personal_standard",
    securityOauthToken: result.securityOauthToken,
    refreshToken: result.refreshToken ?? "",
    machineId,
  };
}

function buildCosyHeaders(body: Uint8Array, url: string, auth: QoderAuth, method: "GET" | "POST" = "POST"): Record<string, string> {
  const key = randomUUID().replaceAll("-", "").slice(0, 16);
  const identity = JSON.stringify({
    name: auth.userName,
    aid: auth.userId,
    uid: auth.userId,
    yx_uid: "",
    organization_id: "",
    organization_name: "",
    user_type: auth.userType,
    security_oauth_token: auth.securityOauthToken,
    refresh_token: auth.refreshToken,
  });
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(key));
  const info = Buffer.concat([cipher.update(identity), cipher.final()]).toString("base64");
  const cosyKey = publicEncrypt({ key: QODER_RSA_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(key)).toString("base64");
  const payload = Buffer.from(JSON.stringify({ version: "v1", requestId: randomUUID(), info, cosyVersion: COSY_VERSION, ideVersion: "" })).toString("base64");
  const date = String(Math.floor(Date.now() / 1000));
  const signature = md5(`${payload}\n${cosyKey}\n${date}\n${Buffer.from(body).toString("latin1")}\n${pathSignature(url)}`);

  // POST requests include body hash, content-type, and stream accept.
  // GET requests (model catalog) use minimal headers — the extra fields
  // cause 403 from Qoder's stricter GET endpoint.
  if (method === "GET") {
    return {
      authorization: `Bearer COSY.${payload}.${signature}`,
      "cosy-data-policy": "agree",
      "cosy-machinetype": "5",
      "cosy-clienttype": "5",
      "cosy-date": date,
      "cosy-user": auth.userId,
      "cosy-key": cosyKey,
      "cosy-business-product": "cli",
      "cosy-business-type": "agent",
      "cosy-scene": "assistant",
      accept: "application/json",
      "accept-encoding": "identity",
      "cosy-version": COSY_VERSION,
      "cosy-machineid": auth.machineId,
      "cosy-machinetoken": auth.machineId,
      "login-version": "v2",
      "cache-control": "no-cache",
      "user-agent": "Go-http-client/2.0",
    };
  }

  return {
    authorization: `Bearer COSY.${payload}.${signature}`,
    "cosy-data-policy": "agree",
    "cosy-machinetype": "5",
    "cosy-machineos": "x86_64_windows",
    "cosy-clienttype": "5",
    "cosy-date": date,
    "cosy-user": auth.userId,
    "cosy-key": cosyKey,
    "cosy-bodyhash": md5(body),
    "cosy-bodylength": String(body.byteLength),
    "cosy-sigpath": pathSignature(url),
    "cosy-organization-id": "",
    "cosy-organization-tags": "",
    "x-request-id": randomUUID(),
    "cosy-business-product": "cli",
    "cosy-business-type": "agent",
    "cosy-scene": "assistant",
    "cosy-version": COSY_VERSION,
    "cosy-machineid": auth.machineId,
    "cosy-machinetoken": auth.machineId,
    "login-version": "v2",
    "content-type": "application/json",
    accept: "text/event-stream",
    "accept-encoding": "identity",
    "cache-control": "no-cache",
    "user-agent": "Go-http-client/2.0",
  };
}

/** Fetches Qoder's current per-account model configurations. */
export async function fetchQoderModels(auth: QoderAuth, signal: AbortSignal): Promise<Map<string, Record<string, unknown>>> {
  // Qoder's token propagation can lag — retry once on auth failure.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    const response = await fetch(QODER_MODEL_LIST_URL, { method: "GET", headers: buildCosyHeaders(new Uint8Array(), QODER_MODEL_LIST_URL, auth, "GET"), signal });
    if (!response.ok) {
      if (attempt === 0 && (response.status === 401 || response.status === 403)) continue;
      throw qoderHttpError(response.status, "model catalog");
    }
    const body: unknown = await response.json();
    const entries = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).chat : undefined;
    if (!Array.isArray(entries)) throw new ProviderCallError(502, "malformed_response", "Qoder model catalog returned an unexpected shape.");
    const models = new Map<string, Record<string, unknown>>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const key = (entry as Record<string, unknown>).key;
      if (typeof key === "string") models.set(key, entry as Record<string, unknown>);
    }
    return models;
  }
  throw new ProviderCallError(502, "unavailable", "Qoder model catalog unreachable after retries.");
}

/** Sends the encoded, COSY-signed Qoder inference request. */
function qoderHttpError(status: number, operation: string): ProviderCallError {
  if (status === 401 || status === 403) return new ProviderCallError(status, "authentication", `Qoder ${operation} rejected the supplied credential.`);
  if (status === 429) return new ProviderCallError(429, "rate_limited", `Qoder ${operation} is rate-limited.`);
  if (status >= 400 && status < 500) return new ProviderCallError(status, "invalid_request", `Qoder ${operation} rejected this request.`);
  return new ProviderCallError(502, "unavailable", `Qoder ${operation} is unavailable.`);
}

export async function callQoder(
  url: string,
  body: Record<string, unknown>,
  modelId: string,
  auth: QoderAuth,
  signal: AbortSignal
): Promise<Response> {
  const encoded = encodeQoderBody(JSON.stringify(body));
  const modelConfig = body.model_config as Record<string, unknown>;
  return fetch(url, {
    method: "POST",
    headers: {
      ...buildCosyHeaders(encoded, url, auth),
      "x-model-key": modelId,
      "x-model-source": typeof modelConfig.source === "string" ? modelConfig.source : "system",
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "Accept-Encoding": "identity",
    },
    body: encoded,
    signal,
  });
}

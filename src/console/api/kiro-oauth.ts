import { Elysia, t } from "elysia";
import { createAccount, updateAccountHealth } from "../db/repos/accounts";
import { consoleError } from "../errors";
import { TokenKeeperError } from "../../tokenkeeper/types";
import { pollKiroDeviceToken, refreshKiroToken, registerKiroClient, startKiroDeviceAuthorization, type KiroBundle, type KiroDeviceRegistration } from "../../tokenkeeper/kiro";

type DeviceSession = { id: string; accountName: string; client: KiroDeviceRegistration; deviceCode: string; expiresAt: number; authMethod: string };
const sessions = new Map<string, DeviceSession>();
function errorResponse(error: unknown, set: { status?: number | string }) {
  if (error instanceof TokenKeeperError) { set.status = error.status; return consoleError(error.status >= 500 ? "internal" : "invalid_request", error.message); }
  set.status = 500; return consoleError("internal", "Kiro OAuth operation failed");
}
function saveBundle(name: string, bundle: KiroBundle) {
  const account = createAccount({ provider: "kiro", name, credentialKind: "oauth", credential: JSON.stringify(bundle), credentialHint: bundle.email ?? bundle.profileArn ?? "Kiro OAuth" });
  updateAccountHealth(account.id, { status: "healthy", errorKind: null, statusCode: null, sanitizedMessage: null, occurredAt: null, retryAt: null, lastRefreshAt: new Date().toISOString() });
  return { accountId: account.id };
}
export const kiroOAuthRoutes = new Elysia({ prefix: "/console/api/providers/kiro/oauth" })
  .post("/device/start", async ({ body, set }) => {
    try {
      const client = await registerKiroClient(body.region);
      const device = await startKiroDeviceAuthorization(client, body.startUrl);
      const id = crypto.randomUUID();
      sessions.set(id, { id, accountName: body.name.trim(), client, deviceCode: device.deviceCode, expiresAt: Date.now() + device.expiresIn * 1000, authMethod: body.method });
      return { sessionId: id, status: "waiting-for-user", verificationUri: device.verificationUri, userCode: device.userCode, expiresAt: Date.now() + device.expiresIn * 1000, intervalSeconds: device.intervalSeconds };
    } catch (error) { return errorResponse(error, set); }
  }, { body: t.Object({ name: t.String({ minLength: 1, maxLength: 120 }), method: t.Union([t.Literal("builder-id"), t.Literal("idc")]), region: t.Optional(t.String({ minLength: 2, maxLength: 32 })), startUrl: t.Optional(t.String({ minLength: 1, maxLength: 500 })) }) })
  .post("/device/:sessionId/poll", async ({ params, set }) => {
    const session = sessions.get(params.sessionId);
    if (!session) { set.status = 404; return consoleError("not_found", "Kiro OAuth session not found"); }
    if (session.expiresAt <= Date.now()) { sessions.delete(session.id); set.status = 410; return consoleError("invalid_request", "Kiro OAuth session expired"); }
    try {
      const result = await pollKiroDeviceToken(session.client, session.deviceCode);
      if (result.status === "pending") return { status: "waiting-for-user", intervalSeconds: 5 };
      const bundle = { ...result.bundle, authMethod: session.authMethod };
      const saved = saveBundle(session.accountName, bundle);
      sessions.delete(session.id);
      return { status: "completed", ...saved };
    } catch (error) { return errorResponse(error, set); }
  })
  .post("/import", async ({ body, set }) => {
    try {
      const metadata = { region: body.region, clientId: body.clientId, clientSecret: body.clientSecret, authMethod: body.authMethod, profileArn: body.profileArn } as const;
      const bundle = await refreshKiroToken(body.refreshToken.trim(), metadata);
      return { status: "completed", ...saveBundle(body.name.trim(), bundle) };
    } catch (error) { return errorResponse(error, set); }
  }, { body: t.Object({ name: t.String({ minLength: 1, maxLength: 120 }), refreshToken: t.String({ minLength: 8, maxLength: 20_000 }), region: t.Optional(t.String({ minLength: 2, maxLength: 32 })), clientId: t.Optional(t.String({ minLength: 1, maxLength: 1000 })), clientSecret: t.Optional(t.String({ minLength: 1, maxLength: 4000 })), authMethod: t.Optional(t.String({ maxLength: 32 })), profileArn: t.Optional(t.String({ maxLength: 1000 })) }) });

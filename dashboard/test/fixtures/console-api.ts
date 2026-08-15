export const consoleSuccessFixture = {
  data: {
    version: "2.0.0-beta",
    environment: "test",
    uptime: "12m",
    accountCount: 2,
    proxyCount: 1,
    apiKeyCount: 1,
    health: {
      status: "ready",
      dependencies: { database: "ready", cache: "degraded" },
    },
  },
} as const;

export const consoleRedactedFixture = {
  data: {
    items: [{ id: "acct-1", providerId: "openai", label: "Primary", enabled: true, credentialHint: "sk-…1234", health: "healthy", apiKey: "must-not-enter-dashboard" }],
  },
} as const;

export const consoleErrorFixture = {
  error: { code: "forbidden", message: "operator scope required" },
} as const;

export const consoleDegradedFixture = {
  data: {
    version: "2.0.0-beta",
    environment: "test",
    uptime: "12m",
    accountCount: 2,
    proxyCount: 1,
    apiKeyCount: 1,
    health: {
      status: "degraded",
      dependencies: { database: "ready", cache: "degraded" },
    },
  },
} as const;
export const consoleCatalogFixture = {
  data: {
    items: [{
      id: "openai",
      name: "OpenAI",
      modelCount: 1,
      accountCount: 1,
      enabled: true,
      configured: true,
      credentialKind: "api_key",
      models: [{ id: "gpt-5", enabled: true, capabilities: { chat: true, media: false } }],
    }],
  },
} as const;

const MIN_PRODUCTION_SECRET_LENGTH = 32;
const MIN_BOOTSTRAP_PASSWORD_LENGTH = 1;
const PLACEHOLDER_PATTERN = /^(?:change-me|replace-with|replace_me|password|secret|default|example)(?:[-_].*)?$/i;

type SecretEnvironment = Readonly<Record<string, string | undefined>>;

function isProductionLike(env: SecretEnvironment): boolean {
  return env.NODE_ENV !== "development" && env.NODE_ENV !== "test";
}

function isStrongValue(value: string, minimumLength: number): boolean {
  return value.length >= minimumLength && !PLACEHOLDER_PATTERN.test(value);
}

/** Validates deployment-provided bootstrap secrets before production startup. */
export function assertProductionBootstrapEnvironment(env: SecretEnvironment = Bun.env): void {
  if (!isProductionLike(env)) return;
  const jwtSecret = env.CONSOLE_JWT_SECRET?.trim();
  if (jwtSecret !== undefined && !isStrongValue(jwtSecret, MIN_PRODUCTION_SECRET_LENGTH)) {
    throw new Error("CONSOLE_JWT_SECRET must be a non-placeholder secret of at least 32 characters");
  }
  const consolePassword = env.CONSOLE_PASSWORD;
  if (consolePassword !== undefined && !isStrongValue(consolePassword, MIN_BOOTSTRAP_PASSWORD_LENGTH)) {
    throw new Error("CONSOLE_PASSWORD must be a non-empty, non-placeholder password");
  }
  const bootstrapApiKey = env.BOOTSTRAP_PROXY_API_KEY?.trim();
  if (bootstrapApiKey !== undefined && !isStrongValue(bootstrapApiKey, MIN_BOOTSTRAP_PASSWORD_LENGTH)) {
    throw new Error("BOOTSTRAP_PROXY_API_KEY must be a non-empty, non-placeholder key");
  }
}

/** Generates a high-entropy secret for first-run persistence when no external secret is supplied. */
export function generateConsoleJwtSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

/** Returns whether a bootstrap password can initialize the console. Production accepts any non-empty, non-placeholder value. */
export function isValidBootstrapPassword(password: string | undefined, env: SecretEnvironment = Bun.env): password is string {
  if (password === undefined) return false;
  return isStrongValue(password, MIN_BOOTSTRAP_PASSWORD_LENGTH);
}

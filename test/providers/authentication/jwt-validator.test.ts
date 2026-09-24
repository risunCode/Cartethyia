import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, constants, sign } from "node:crypto";
import { providerJwtVerification } from "../../../src/providers/provider-metadata";
import {
  JwksVerifier,
  parseJwt,
  resetJwksVerifiersForTests,
  validateIssuedAccessToken,
  validateJwtClaims,
} from "../../../src/providers/authentication/jwt-validator";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });

function rsaJwk(kid = "rsa-1"): Record<string, unknown> {
  return { ...rsa.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
}
function ecJwk(kid = "ec-1"): Record<string, unknown> {
  return { ...ec.publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" };
}

function signRs256(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key = rsa.privateKey,
): string {
  const input = `${encode(header)}.${encode(payload)}`;
  const signature = sign("sha256", Buffer.from(input, "utf8"), key).toString("base64url");
  return `${input}.${signature}`;
}

function signEs256(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  const input = `${encode(header)}.${encode(payload)}`;
  const signature = sign("sha256", Buffer.from(input, "utf8"), {
    key: ec.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${input}.${signature}`;
}

function signPs256(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  const input = `${encode(header)}.${encode(payload)}`;
  const signature = sign("sha256", Buffer.from(input, "utf8"), {
    key: rsa.privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64url");
  return `${input}.${signature}`;
}

function jwksFetch(keys: unknown[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ keys }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("parseJwt", () => {
  test("parses a well-formed compact JWS", () => {
    const parsed = parseJwt(signRs256({ alg: "RS256", typ: "JWT" }, { sub: "user-1" }));
    expect(parsed?.header.alg).toBe("RS256");
    expect(parsed?.payload.sub).toBe("user-1");
  });

  test("rejects structurally invalid tokens", () => {
    expect(parseJwt("a.b")).toBeUndefined();
    expect(parseJwt("not-a-jwt")).toBeUndefined();
    expect(parseJwt(`${encode({ alg: "none" })}.${encode({ sub: "x" })}.`)).toBeUndefined();
    expect(parseJwt(`${encode({ alg: "RS256" })}.@@@.sig`)).toBeUndefined();
    expect(parseJwt(`${encode({ alg: "RS256" })}.${encode([1, 2])}.sig`)).toBeUndefined();
  });
});

describe("validateJwtClaims", () => {
  const now = 1_700_000_000_000;
  const nowSeconds = now / 1000;

  test("accepts a token inside its validity window", () => {
    expect(
      validateJwtClaims({ exp: nowSeconds + 100, nbf: nowSeconds - 100 }, { now }),
    ).toBeUndefined();
  });

  test("rejects expired tokens beyond the skew allowance", () => {
    expect(validateJwtClaims({ exp: nowSeconds - 120 }, { now })).toBe("expired");
  });

  test("accepts an expiry inside the skew allowance", () => {
    expect(validateJwtClaims({ exp: nowSeconds - 30 }, { now })).toBeUndefined();
  });

  test("rejects not-yet-valid and future-issued tokens", () => {
    expect(validateJwtClaims({ nbf: nowSeconds + 120 }, { now })).toBe("not_yet_valid");
    expect(validateJwtClaims({ iat: nowSeconds + 120 }, { now })).toBe("issued_in_future");
  });

  test("rejects present-but-malformed numeric claims", () => {
    expect(validateJwtClaims({ exp: "soon" }, { now })).toBe("malformed_claim");
  });

  test("enforces issuer and audience when expected", () => {
    expect(
      validateJwtClaims(
        { iss: "https://issuer.test", aud: ["api", "other"] },
        { now, issuer: "https://issuer.test", audience: "api" },
      ),
    ).toBeUndefined();
    expect(validateJwtClaims({ iss: "https://evil.test" }, { now, issuer: "https://issuer.test" })).toBe(
      "issuer_mismatch",
    );
    expect(validateJwtClaims({ aud: "other" }, { now, audience: "api" })).toBe("audience_mismatch");
  });
});

describe("JwksVerifier", () => {
  afterEach(() => resetJwksVerifiersForTests());

  test("verifies an RS256 token against the JWKS", async () => {
    const verifier = new JwksVerifier({
      url: "https://issuer.test/jwks",
      fetch: jwksFetch([rsaJwk()]),
    });
    const token = signRs256({ alg: "RS256", kid: "rsa-1" }, { sub: "u" });
    expect((await verifier.verify(token))?.payload.sub).toBe("u");
  });

  test("verifies an ES256 token (raw r||s signature)", async () => {
    const verifier = new JwksVerifier({
      url: "https://issuer.test/jwks-ec",
      fetch: jwksFetch([ecJwk()]),
    });
    const token = signEs256({ alg: "ES256", kid: "ec-1" }, { sub: "u" });
    expect((await verifier.verify(token))?.payload.sub).toBe("u");
  });

  test("verifies a PS256 token (RSA-PSS padding)", async () => {
    const verifier = new JwksVerifier({
      url: "https://issuer.test/jwks-ps",
      fetch: jwksFetch([{ ...rsa.publicKey.export({ format: "jwk" }), kid: "rsa-1", alg: "PS256" }]),
    });
    const token = signPs256({ alg: "PS256", kid: "rsa-1" }, { sub: "u" });
    expect((await verifier.verify(token))?.payload.sub).toBe("u");
  });

  test("rejects a tampered payload", async () => {
    const verifier = new JwksVerifier({
      url: "https://issuer.test/jwks-tamper",
      fetch: jwksFetch([rsaJwk()]),
    });
    const token = signRs256({ alg: "RS256", kid: "rsa-1" }, { sub: "u" });
    const [header, , signature] = token.split(".");
    const tampered = `${header}.${encode({ sub: "admin" })}.${signature}`;
    expect(await verifier.verify(tampered)).toBeUndefined();
  });

  test("rejects a token signed by a different key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const verifier = new JwksVerifier({
      url: "https://issuer.test/jwks-wrong-key",
      fetch: jwksFetch([rsaJwk()]),
    });
    const token = signRs256({ alg: "RS256", kid: "rsa-1" }, { sub: "u" }, other.privateKey);
    expect(await verifier.verify(token)).toBeUndefined();
  });

  test("rejects unsupported algorithms such as HS256", async () => {
    const verifier = new JwksVerifier({
      url: "https://issuer.test/jwks-hs",
      fetch: jwksFetch([rsaJwk()]),
    });
    const token = `${encode({ alg: "HS256", kid: "rsa-1" })}.${encode({ sub: "u" })}.${Buffer.from("sig").toString("base64url")}`;
    expect(await verifier.verify(token)).toBeUndefined();
  });
});

describe("validateIssuedAccessToken", () => {
  afterEach(() => resetJwksVerifiersForTests());

  test("passes opaque tokens through", async () => {
    expect(await validateIssuedAccessToken("opaque-token")).toEqual({ valid: true, verified: false });
  });

  test("rejects an expired JWT", async () => {
    const token = signRs256({ alg: "RS256" }, { exp: Math.floor(Date.now() / 1000) - 3_600 });
    expect(await validateIssuedAccessToken(token)).toEqual({ valid: false, reason: "expired" });
  });

  test("accepts a valid JWT without a configured JWKS (claims only)", async () => {
    const token = signRs256({ alg: "RS256" }, { exp: Math.floor(Date.now() / 1000) + 3_600 });
    expect(await validateIssuedAccessToken(token)).toEqual({ valid: true, verified: false });
  });

  test("verifies the signature when a JWKS URL is configured", async () => {
    const token = signRs256(
      { alg: "RS256", kid: "rsa-1" },
      { exp: Math.floor(Date.now() / 1000) + 3_600 },
    );
    const result = await validateIssuedAccessToken(token, {
      jwksUrl: "https://issuer.test/jwks-valid",
      fetch: jwksFetch([rsaJwk()]),
    });
    expect(result).toEqual({ valid: true, verified: true });
  });

  test("rejects a bad signature when JWKS verification is enabled", async () => {
    const token = signRs256(
      { alg: "RS256", kid: "rsa-1" },
      { exp: Math.floor(Date.now() / 1000) + 3_600 },
    );
    const [header, , signature] = token.split(".");
    const tampered = `${header}.${encode({ exp: Math.floor(Date.now() / 1000) + 3_600, sub: "admin" })}.${signature}`;
    const result = await validateIssuedAccessToken(tampered, {
      jwksUrl: "https://issuer.test/jwks-invalid",
      fetch: jwksFetch([rsaJwk()]),
    });
    expect(result).toEqual({ valid: false, reason: "signature_invalid" });
  });
});

describe("providerJwtVerification", () => {
  test("returns the provider's manifest-declared policy without any env", () => {
    expect(providerJwtVerification("grok")).toEqual({
      issuer: "https://auth.x.ai",
      jwksUrl: "https://auth.x.ai/.well-known/jwks.json",
    });
  });

  test("returns an empty policy for providers without a published JWKS", () => {
    expect(providerJwtVerification("devin")).toEqual({});
    expect(providerJwtVerification("not-a-provider")).toEqual({});
  });
});

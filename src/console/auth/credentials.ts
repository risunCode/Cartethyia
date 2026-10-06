// Console authentication, sessions, lockouts, first-boot setup, and audit.
const ARGON2ID_PREFIX = "$argon2id$";

export class ConsoleCredentialService {
  /**
   * Hashes a console password with argon2id via Bun's native implementation:
   * the OWASP-recommended password KDF here, chosen over the HMAC-SHA256
   * `hashSecret` used for API keys because passwords are low-entropy user
   * material and need a memory-hard KDF to resist offline brute force. The
   * 64 MiB / t=3 tuning balances brute-force resistance against the console
   * login latency budget; salt and parameters are embedded in the returned
   * PHC string so future rehashing can migrate costs without a data migration.
   */
  async hashPassword(password: string): Promise<string> {
    if (typeof password !== "string" || password.length === 0) {
      throw new Error("Password must not be empty");
    }
    return Bun.password.hash(password, {
      algorithm: "argon2id",
      memoryCost: 65536,
      timeCost: 3,
    });
  }

  /**
   * Constant-time verification against an argon2id PHC string. Deliberately
   * returns `false` instead of throwing for malformed, non-argon2id, or
   * undecodable hashes: a corrupted `password_hash` row must surface as an
   * ordinary failed login (counted by the lockout service), never as a 500
   * that lets an attacker probe hash integrity or bypass the failure counter.
   * Legacy/migrated hashes are rejected here rather than verified — a hash
   * that does not start with `$argon2id$` can only originate from a foreign
   * scheme this deployment never issued.
   */
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    if (
      typeof password !== "string" ||
      typeof hash !== "string" ||
      !hash.startsWith(ARGON2ID_PREFIX)
    ) {
      return false;
    }
    try {
      return await Bun.password.verify(password, hash);
    } catch {
      return false;
    }
  }
}

// Console sessions are opaque, hashed database tokens — not JWTs. The cookie
// and database expiry share one policy so a successful login remains valid for
// the full local/deployed session window.

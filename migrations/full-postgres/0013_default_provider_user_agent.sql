-- Route identity: a provider with no operator-chosen User-Agent now defaults
-- to the Claude Code CLI identity instead of the Codex CLI identity.
--
-- The column default only ever reached rows written without one — every
-- `provider_routing_settings` insert supplies `user_agent` explicitly, so in
-- practice the column default governed nothing and the real default was the
-- `DEFAULT_PROVIDER_USER_AGENT` literal read by the console and the route
-- catalog. That literal named `codex_cli_rs/0.156.1`, so a bare API key
-- identified as Codex's CLI on requests that most often reached neither
-- upstream: a provider keying on the client string would act on it, and one
-- that is not Codex would see a client it does not serve.
--
-- The stored rows are rewritten rather than left alone for one reason: a row
-- holding exactly the old frozen default cannot be distinguished from an
-- operator who deliberately picked Codex. Rewriting *that* one value is the
-- only safe reading — it is simultaneously the default this migration retires
-- and a value an operator could have chosen. Any other stored identity (an
-- empty string, a `Cartethyia/…` gateway agent, a Codex identity on a version
-- the frozen default never carried) is untouched, so an operator's own choice
-- survives.
--
-- The new default is version-bearing (`claude-cli/2.1.293 (external, cli)`) and
-- matches `VERSION_SOURCES.claudeCli.fallback`. The live default read at request
-- time comes from `buildClaudeCliUserAgent()`, which resolves the version
-- through the live resolver; this column default is what an insert that omits
-- the column gets, and it is kept in step by a migration rather than by a
-- shared constant, because a SQL column default cannot call into the process.
ALTER TABLE "provider_routing_settings"
  ALTER COLUMN "user_agent" SET DEFAULT 'claude-cli/2.1.293 (external, cli)';

--> statement-breakpoint
UPDATE "provider_routing_settings"
SET "user_agent" = 'claude-cli/2.1.293 (external, cli)'
WHERE "user_agent" = 'codex_cli_rs/0.156.1';
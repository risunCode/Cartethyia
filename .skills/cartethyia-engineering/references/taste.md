# Taste

How a change should read in this repository. Match the surrounding file. Do not
introduce a second style beside one that already exists.

## Shape

- One behavior, one owner. A helper used once, by one caller, stays in that file.
- Prefer the smallest complete change. Do not add a layer, a registry, or a
  config flag for a decision the caller already knows.
- A function that can say what it returns in its name does not need a comment
  that repeats the name.
- Do not leave a compatibility alias so old imports keep compiling. Migrate the
  callers and delete the old name.
- Do not add a fallback that hides a failed invariant. Fail closed, with the
  existing error type for that boundary (`GatewayError` on the gateway,
  `ConsoleDomainError` on the console).

## Types

- No `any`, no `as unknown as`, no suppression, no widened compiler setting.
- A value crossing a boundary is untrusted. Narrow it before use. A cast is a
  claim that the check already happened.
- Optional fields stay optional. Do not coerce a missing value into a default
  that changes behavior, unless the schema already declares that default.
- `exactOptionalPropertyTypes` is on. Omit a key whose value is `undefined`
  instead of assigning it.

## Names

- Role filenames: `contracts.ts`, `routes.ts`, `store.ts`, `service.ts`,
  `errors.ts`. No `index.ts` barrel.
- A boolean reads as a predicate (`enabled`, `requiresSetup`). A function reads
  as a verb (`applyRestore`, `clearOwnedRows`).
- Do not rename a wire field, a database column, or a provider header to match
  local taste. Those spellings are contracts.

## Comments

- Comment the constraint the next reader cannot see from the code: why a lock
  exists, why a column is absent, why an order is load-bearing.
- Do not comment what the next line does.
- A comment that names a file, a migration, or a symbol must name one that
  exists. After a rename, update it in the same change.

## Data

- A restore, a migration, and a delete say what they keep and what they drop.
  Silence is not an instruction to delete.
- Copy before drop when the data must survive. Drop without a copy only when
  the feature itself is being removed.
- Do not log or return a credential, a token, a password hash, or a request body.

## Dashboard

- Browser code stays browser-safe. It calls `/console/api`. It does not import
  the backend.
- A mutation toasts both arms. A silent `mutate` is unfinished.
- Use the existing dialog sizes, query keys, and `cartethyia:<area>:<name>`
  storage prefix. Do not invent a parallel set.

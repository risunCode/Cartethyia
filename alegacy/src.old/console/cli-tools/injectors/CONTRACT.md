# CLI Tools Injector Contract

## Interface (must implement)

```typescript
import type { ToolInjector, ToolStatus, ApplyInput, ApplyResult, DownloadResult } from "../types";
import { /* needed helpers */ } from "../fs-ops";

export const xxxInjector: ToolInjector = {
  toolId: "xxx",
  async getStatus(): Promise<ToolStatus> { ... },
  async apply(input: ApplyInput): Promise<ApplyResult> { ... },
  async reset(): Promise<ApplyResult> { ... },
  async download(input: ApplyInput): Promise<DownloadResult> { ... },
};
```

## Available fs-ops helpers

```typescript
import {
  homeDir,           // os.homedir()
  join,              // path.join (re-exported)
  fileExists,        // Bun.file(path).exists()
  readJsonFile,      // parse JSON with trailing comma tolerance, null if missing
  writeJsonFile,     // JSON.stringify(data, null, 2) → Bun.write
  readTextFile,      // null if missing
  writeTextFile,     // Bun.write
  ensureDir,         // mkdir -p
  checkBinaryInstalled, // which/where + fallback config file check
  ensureV1Suffix,    // add /v1 if missing
  stripV1Suffix,     // remove /v1 if present
  stripTrailingSlash,
  isLocalEndpoint,   // test localhost/127.0.0.1/cartethyia
  keyPrefix,         // first 8 chars + "..."
  tomlGet,           // read flat key="value" from TOML
  tomlUpsertFlat,    // upsert key="value" line
  tomlRemoveFlat,    // remove key=value line
  tomlUpsertSection, // upsert [section] with body
  tomlRemoveSection, // remove [section] block
  tomlHasSection,    // check [section] exists
  envUpsert,         // upsert KEY=VALUE in .env text
  envRemove,         // remove KEY=VALUE line
  envGet,            // read KEY value from .env text
} from "../fs-ops";
```

## ToolStatus shape

```typescript
interface ToolStatus {
  toolId: string;
  installed: boolean;
  configured: boolean;       // true if config already points to Cartethyia
  settingsPath: string | null;
  currentEndpoint: string | null;
  currentApiKeyPrefix: string | null;  // sanitized, never full secret
  currentModels: readonly string[] | null;
  message?: string;
}
```

## ApplyInput shape

```typescript
interface ApplyInput {
  endpoint: string;     // raw URL like "http://localhost:12800"
  apiKey: string;       // full secret
  models: readonly string[];
  activeModel?: string;
  subagentModel?: string;
}
```

## Rules

1. Use `import type` for type-only imports
2. NO dynamic imports
3. NO thin wrapper functions (inline trivial expressions)
4. Merge config, never overwrite user's existing settings
5. Reset removes ONLY Cartethyia-injected fields, preserves everything else
6. Download generates config text without writing to filesystem
7. Provider name in configs is "cartethyia" (NOT "9router")
8. Use platform() for OS-specific paths (check IS_WIN in fs-ops or node:os)
9. Export const named `xxxInjector` (e.g. `clineInjector`, `opencodeInjector`)

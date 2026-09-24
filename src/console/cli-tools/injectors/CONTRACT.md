# CLI Tools Injector Contract

## Interface (must implement)

File-based tools do not implement `ToolInjector` by hand: they declare an
`InjectorSpec` in a co-located `./<tool>.ts` file next to this doc and are
built by `createFileInjector`. The only dispatch point is the `INJECTORS` map
in `./driver`, keyed by tool id. Guide-only tools (`configType: "guide"` in the
registry) share `guideInjectorFor` in the same `./driver` instead of a spec.

```typescript
import type { InjectorSpec } from "../contracts";
import { homeDir, join } from "../fs-ops";

export const xxxSpec: InjectorSpec = {
  toolId: "xxx",
  resolvePath: () => join(homeDir(), ".xxx", "config.json"),
  readStatus: async (path) => ({ ... }),
  apply: async (input, path) => { ... },
  reset: async (path) => { ... },
  download: (input) => ({ content, filename, mimeType }),
};
```

`InjectorSpec` methods mirror the `ToolInjector` lifecycle, with the path
threaded in: `readStatus(path)` / `apply(input, path)` / `reset(path)` /
`download(input)`. The driver synthesizes `getStatus()` on top of
`readStatus`, and `StatusDetails` is the declared return type of `readStatus`.

Optional members the existing specs use: `displayName`, `binary`,
`checkInstalled`, `keepSettingsPathOnMissing`, `resetEvenIfMissing`,
`resolveDir`, and `messages`.

## Available fs-ops helpers

```typescript
import {
  homeDir, // os.homedir()
  join, // path.join (re-exported)
  fileExists, // Bun.file(path).exists()
  readJsonFile, // parse JSON with trailing comma tolerance, null if missing
  writeJsonFile, // JSON.stringify(data, null, 2) → Bun.write
  readTextFile, // null if missing
  writeTextFile, // Bun.write
  ensureDir, // mkdir -p
  removeFile, // delete a file if it exists
  checkBinaryInstalled, // which/where on the current PATH
  ensureV1Suffix, // add /v1 if missing
  stripV1Suffix, // remove /v1 if present
  isLocalEndpoint, // test localhost/127.0.0.1/0.0.0.0/cartethyia
  keyPrefix, // first 8 chars + "..." (keys shorter than 8 returned verbatim)
  textGet, // read a flat/sectionKey/section field
  textHas, // check a field or [section] exists
  textUpsert, // upsert a flat/sectionKey value, or replace a [section] body
  textRemove, // remove a flat/sectionKey/section field
  // TextSelector = { kind: "flat", key, format?: "toml"|"env", insertAtTop? }
  //              | { kind: "sectionKey", section, key }
  //              | { kind: "section", section }
} from "../fs-ops";
```

## ToolStatus shape

```typescript
interface ToolStatus {
  toolId: string;
  installed: boolean;
  configured: boolean; // true if config already points to Cartethyia
  settingsPath: string | null;
  currentEndpoint: string | null;
  currentApiKeyPrefix: string | null; // sanitized, never full secret
  currentModels: readonly string[] | null;
  message?: string;
}
```

## ApplyInput shape

```typescript
interface ApplyInput {
  endpoint: string; // raw URL like "http://localhost:12800"
  apiKey: string; // full secret
  modelIds: readonly string[];
  modelSlots?: Readonly<Record<string, string>>;
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
7. Provider name in configs is "cartethyia"
8. Use platform() for OS-specific paths (import `platform` from node:os; `IS_WIN` in fs-ops is module-private, not exported)
9. Register the spec in the `FILE_INJECTORS` map in `./driver` under its tool id; do not export a per-tool injector constant

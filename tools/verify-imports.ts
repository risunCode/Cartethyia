import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const MODULE_PATH = "github.com/cartethyia/daemon";
const GENERIC_PACKAGE_NAMES = new Set(["utils", "helpers", "common", "shared", "core", "services"]);
const LEGACY_INTERNAL_PATHS = [
  "runtime",
  "server",
  "proxy",
  "observability",
  "security",
  "config",
  "accounts/drivers",
  "accounts/flow",
  "providers/apikey",
  "providers/oauth",
  "providers/policies",
];
const REFERENCE_REPOSITORIES = ["cartethyia-107", "etteum-pool"];
const SQL_IMPORTS = [
  "database/sql",
  "database/sql/driver",
  "github.com/uptrace/bun",
  "github.com/mattn/go-sqlite3",
  "modernc.org/sqlite",
  "github.com/lib/pq",
  "github.com/jackc/pgx",
];

interface ImportSpec {
  readonly path: string;
  readonly line: number;
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
}

interface SourceFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly imports: readonly ImportSpec[];
  readonly packageName: string | undefined;
  readonly isTest: boolean;
}

function usage(): never {
  console.error("Usage: bun tools/verify-imports.ts [--root <project-root>]");
  process.exit(2);
}

function parseRootArgument(args: readonly string[]): string {
  if (args.length === 0) {
    return resolve(import.meta.dir, "..");
  }
  if (args.length === 2 && args[0] === "--root") {
    return resolve(args[1]);
  }
  if (args.length === 1 && args[0].startsWith("--root=")) {
    const value = args[0].slice("--root=".length);
    if (value.length > 0) {
      return resolve(value);
    }
  }
  usage();
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function locateModuleRoot(projectRoot: string): Promise<string> {
  const candidates = [projectRoot, join(projectRoot, "router")];
  for (const candidate of candidates) {
    if (await isDirectory(join(candidate, "internal"))) {
      return candidate;
    }
  }
  throw new Error(`no Go internal source tree found below ${projectRoot}`);
}

async function collectGoFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "vendor") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectGoFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".go")) {
      files.push(path);
    }
  }
  return files;
}

function parseImports(source: string): ImportSpec[] {
  const imports: ImportSpec[] = [];
  const lines = source.split(/\r?\n/);
  let inImportBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!inImportBlock) {
      if (/^import\s*\(/.test(trimmed)) {
        inImportBlock = true;
        continue;
      }
      const single = trimmed.match(/^import\s+(?:(?:[._]|[A-Za-z_]\w*)\s+)?"([^"]+)"/);
      if (single !== null) {
        imports.push({ path: single[1], line: index + 1 });
      }
      continue;
    }

    if (trimmed === ")") {
      inImportBlock = false;
      continue;
    }
    const grouped = trimmed.match(/^(?:(?:[._]|[A-Za-z_]\w*)\s+)?"([^"]+)"/);
    if (grouped !== null) {
      imports.push({ path: grouped[1], line: index + 1 });
    }
  }
  return imports;
}

function parsePackageName(source: string): string | undefined {
  const match = source.match(/^\s*package\s+([A-Za-z_]\w*)/m);
  return match?.[1];
}

async function readSourceFile(absolutePath: string, moduleRoot: string): Promise<SourceFile> {
  const source = await readFile(absolutePath, "utf8");
  const relativePath = relative(moduleRoot, absolutePath).split(sep).join("/");
  return {
    absolutePath,
    relativePath,
    imports: parseImports(source),
    packageName: parsePackageName(source),
    isTest: absolutePath.endsWith("_test.go"),
  };
}

function internalImport(importPath: string, owner: string): boolean {
  return new RegExp(`(?:^|/)internal/${owner}(?:/|$)`).test(importPath);
}

function legacyImport(importPath: string): string | undefined {
  for (const legacyPath of LEGACY_INTERNAL_PATHS) {
    if (internalImport(importPath, legacyPath)) {
      return legacyPath;
    }
  }
  return undefined;
}

function referenceRepository(importPath: string): string | undefined {
  const lowerPath = importPath.toLowerCase();
  return REFERENCE_REPOSITORIES.find((repository) => lowerPath.includes(repository));
}

function ownerOf(relativePath: string): string | undefined {
  const parts = relativePath.split("/");
  return parts[0] === "internal" ? parts[1] : undefined;
}

function genericDirectory(relativePath: string): string | undefined {
  const parts = relativePath.split("/");
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!GENERIC_PACKAGE_NAMES.has(part)) {
      continue;
    }
    if (part === "services" && parts[0] === "internal" && parts[1] === "console" && parts[2] === "services") {
      continue;
    }
    return part;
  }
  return undefined;
}

function genericImport(importPath: string): string | undefined {
  const parts = importPath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!GENERIC_PACKAGE_NAMES.has(part)) {
      continue;
    }
    const isConsoleServices =
      part === "services" && index >= 2 && parts[index - 2] === "internal" && parts[index - 1] === "console";
    if (!isConsoleServices) {
      return part;
    }
  }
  return undefined;
}

function addViolation(violations: Violation[], file: SourceFile, line: number, rule: string, detail: string): void {
  violations.push({ file: file.relativePath, line, rule, detail });
}

function checkSourcePath(file: SourceFile, violations: Violation[]): void {
  const legacyPath = file.relativePath.startsWith("internal/")
    ? legacyImport(`${MODULE_PATH}/${file.relativePath}`)
    : undefined;
  if (legacyPath !== undefined) {
    addViolation(violations, file, 1, "legacy-source-path", `old internal path internal/${legacyPath}`);
  }

  const generic = genericDirectory(file.relativePath);
  if (generic !== undefined) {
    addViolation(violations, file, 1, "generic-package-directory", `generic Go package directory ${generic}`);
  }
  if (file.packageName !== undefined && GENERIC_PACKAGE_NAMES.has(file.packageName)) {
    const isConsoleServices = file.relativePath.startsWith("internal/console/services/");
    if (!isConsoleServices || file.packageName !== "services") {
      addViolation(violations, file, 1, "generic-package-name", `generic Go package ${file.packageName}`);
    }
  }
}

function checkImport(file: SourceFile, spec: ImportSpec, violations: Violation[]): void {
  const generic = genericImport(spec.path);
  if (generic !== undefined) {
    addViolation(violations, file, spec.line, "generic-package-import", `generic Go package import ${spec.path}`);
  }

  const legacyPath = legacyImport(spec.path);
  if (legacyPath !== undefined) {
    addViolation(violations, file, spec.line, "legacy-import", `old internal import ${spec.path}`);
  }

  if (!file.isTest) {
    const reference = referenceRepository(spec.path);
    if (reference !== undefined) {
      addViolation(violations, file, spec.line, "reference-runtime-import", `runtime import from reference repository ${reference}`);
    }
  }

  const owner = ownerOf(file.relativePath);
  const forbiddenByOwner: Record<string, readonly string[]> = {
    protocol: ["router", "providers", "storage", "telemetry", "gateway", "console", "egress"],
    providers: ["router"],
    accounts: ["router"],
    egress: ["accounts"],
    gateway: ["console", "storage", "providers", "accounts", "egress"],
  };
  const forbiddenOwners = owner === undefined ? undefined : forbiddenByOwner[owner];
  if (forbiddenOwners !== undefined) {
    const forbiddenOwner = forbiddenOwners.find((candidate) => internalImport(spec.path, candidate));
    if (forbiddenOwner !== undefined) {
      addViolation(violations, file, spec.line, "owner-import-direction", `${owner} must not import internal/${forbiddenOwner}: ${spec.path}`);
    }
  }

  if (owner === "console" && !file.isTest && SQL_IMPORTS.some((prefix) => spec.path === prefix || spec.path.startsWith(`${prefix}/`))) {
    addViolation(violations, file, spec.line, "console-sql-import", `console runtime must not import SQL/storage driver ${spec.path}`);
  }
}

function sortViolations(violations: Violation[]): Violation[] {
  return violations.sort((left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line || left.rule.localeCompare(right.rule) || left.detail.localeCompare(right.detail),
  );
}

async function run(): Promise<number> {
  const projectRoot = parseRootArgument(process.argv.slice(2));
  const moduleRoot = await locateModuleRoot(projectRoot);
  const files = await collectGoFiles(moduleRoot);
  const sourceFiles = await Promise.all(files.map((file) => readSourceFile(file, moduleRoot)));
  const violations: Violation[] = [];

  for (const file of sourceFiles) {
    checkSourcePath(file, violations);
    for (const spec of file.imports) {
      checkImport(file, spec, violations);
    }
  }

  const sortedViolations = sortViolations(violations);
  if (sortedViolations.length > 0) {
    for (const violation of sortedViolations) {
      console.error(`${violation.file}:${violation.line}: [${violation.rule}] ${violation.detail}`);
    }
    console.error(`Import boundary check failed with ${sortedViolations.length} violation(s).`);
    return 1;
  }

  console.log(`Import boundary check passed (${sourceFiles.length} Go source file(s)).`);
  return 0;
}

void run().then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

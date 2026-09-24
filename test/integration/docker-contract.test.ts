import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Docker contract test: validates Dockerfile structure and deployment safety
 * without building the image. Tests verify:
 * - Multi-stage build structure
 * - No source code or node_modules in runtime stage
 * - Required directives (PORT, STOPSIGNAL, HEALTHCHECK)
 * - Non-root user execution
 * - Proper bind mount handling in entrypoint
 */

interface DockerfileStage {
  name: string;
  instructions: Record<string, string[]>;
}

function parseDockerfile(content: string): DockerfileStage[] {
  const lines = content.split("\n");
  const stages: DockerfileStage[] = [];
  let currentStage: DockerfileStage | null = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line) continue;

    // Handle line continuation with backslash
    while (line.trimEnd().endsWith("\\") && i + 1 < lines.length) {
      const nextLine = lines[++i];
      if (!nextLine) break;
      line = line.trimEnd().slice(0, -1) + nextLine.trimStart();
    }

    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Detect FROM instruction (stage marker)
    if (trimmed.toUpperCase().startsWith("FROM ")) {
      if (currentStage) {
        stages.push(currentStage);
      }

      const stageMatch = trimmed.match(
        /FROM(?:\s+--[^\s]+)*\s+[\w\-.:/@]+(?:\s+(?:AS\s+([\w-]+)))?/i,
      );
      const stageName = stageMatch?.[1] || `stage-${stages.length}`;

      currentStage = {
        name: stageName,
        instructions: {},
      };
    }

    // Collect instructions for current stage
    if (currentStage) {
      const instructionMatch = trimmed.match(/^([A-Z]+)\s+(.*)/i);
      if (instructionMatch && instructionMatch[1] && instructionMatch[2] !== undefined) {
        const instruction = instructionMatch[1];
        const args = instructionMatch[2];
        const key = instruction.toUpperCase();

        if (!currentStage.instructions[key]) {
          currentStage.instructions[key] = [];
        }
        currentStage.instructions[key].push(args);
      }
    }
  }

  if (currentStage) {
    stages.push(currentStage);
  }

  return stages;
}

describe("Docker Contract", () => {
  const dockerfilePath = resolve("Dockerfile");
  const dockerignorePath = resolve(".dockerignore");
  const composePath = resolve("docker-compose.yml");
  const entrypointPath = resolve("docker-entrypoint.sh");

  let dockerfileContent: string;
  let dockerignoreContent: string;
  let composeContent: string;
  let entrypointContent: string;
  let stages: DockerfileStage[];
  beforeAll(() => {
    dockerfileContent = readFileSync(dockerfilePath, "utf-8");
    dockerignoreContent = readFileSync(dockerignorePath, "utf-8");
    composeContent = readFileSync(composePath, "utf-8");
    entrypointContent = readFileSync(entrypointPath, "utf-8");
    stages = parseDockerfile(dockerfileContent);
  });
  it("runs only the gateway app and Redis; PostgreSQL stays external", () => {
    expect(composeContent).toMatch(/^\s{2}app:/m);
    expect(composeContent).toMatch(/^\s{2}redis:/m);
    expect(composeContent).not.toMatch(/^\s{2}postgres:/m);
    expect(composeContent).toContain("DATABASE_URL");
    expect(composeContent).toContain("REDIS_URL: redis://redis:6379");
  });

  // Helper to safely access the runtime stage (last stage)
  function getRuntimeStage(): DockerfileStage {
    const stage = stages.at(-1);
    if (!stage) {
      throw new Error("Runtime stage not found");
    }
    return stage;
  }


  it("has multi-stage build with builder and runtime stages", () => {
    const stageNames = stages.map((s) => s.name);
    expect(stageNames).toContain("builder");
    expect(stageNames.some((name) => name === "builder")).toBe(true);
    // Runtime stage should be the last one
    expect(getRuntimeStage().name).not.toBe("builder");
  });

  it("uses pinned oven/bun base image for builder stage", () => {
    const builderStage = stages.find((s) => s.name === "builder");
    expect(builderStage).toBeDefined();

    const fromInstructions = builderStage!.instructions.FROM || [];
    expect(fromInstructions.length).toBeGreaterThan(0);

    const fromLine = fromInstructions[0]!;
    expect(fromLine).toContain("oven/bun");
    expect(fromLine).toContain("1.4.2");
    expect(fromLine).toContain("debian");
    expect(fromLine).toContain("@sha256:");
  });

  it("runtime stage uses slim base image", () => {
    const runtimeStage = getRuntimeStage();
    const fromInstructions = runtimeStage.instructions.FROM || [];
    expect(fromInstructions.length).toBeGreaterThan(0);

    const fromLine = fromInstructions[0]!.toLowerCase();
    expect(fromLine).toMatch(/debian.*slim|alpine|distroless/i);
  });

  it("copies compiled binary to runtime stage", () => {
    const runtimeStage = getRuntimeStage();
    const copyInstructions = runtimeStage.instructions.COPY || [];

    const hasBinaryCopy = copyInstructions.some(
      (copy) => copy.includes("cartethyia") || copy.includes("dist/cartethyia"),
    );
    expect(hasBinaryCopy).toBe(true);
  });


  it("ships no child-process pool config directory", () => {
    // The child-process pool flavor was removed; the image no longer needs a
    // writable directory for generated proxy configs.
    const runtimeStage = getRuntimeStage();
    const runInstructions = runtimeStage.instructions.RUN || [];
    expect(runInstructions.some((run) => run.includes("/app/configs"))).toBe(false);
  });

  it("copies migrations to runtime stage", () => {
    const runtimeStage = getRuntimeStage();
    const copyInstructions = runtimeStage.instructions.COPY || [];

    const hasMigrationsCopy = copyInstructions.some((copy) => copy.includes("migrations"));
    expect(hasMigrationsCopy).toBe(true);
  });

  it("does not copy source code to runtime stage", () => {
    const runtimeStage = getRuntimeStage();
    const copyInstructions = runtimeStage.instructions.COPY || [];

    const hasSourceCopy = copyInstructions.some(
      (copy) => copy.includes("/src") || copy.includes(" src "),
    );
    expect(hasSourceCopy).toBe(false);
  });

  it("does not copy node_modules to runtime stage", () => {
    const runtimeStage = getRuntimeStage();
    const copyInstructions = runtimeStage.instructions.COPY || [];

    const hasNodeModules = copyInstructions.some((copy) => copy.includes("node_modules"));
    expect(hasNodeModules).toBe(false);
  });

  it("exposes the application port (12800, matching PORT default)", () => {
    const runtimeStage = getRuntimeStage();
    const exposeInstructions = runtimeStage.instructions.EXPOSE || [];

    const exposesPort = exposeInstructions.some((expose) => expose.includes("12800"));
    expect(exposesPort).toBe(true);
  });

  it("sets STOPSIGNAL to SIGTERM for graceful shutdown", () => {
    const runtimeStage = getRuntimeStage();
    const stopSignalInstructions = runtimeStage.instructions.STOPSIGNAL || [];

    expect(stopSignalInstructions.length).toBeGreaterThan(0);
    expect(stopSignalInstructions[0]).toContain("SIGTERM");
  });

  it("includes HEALTHCHECK directive with /health/ready endpoint", () => {
    const runtimeStage = getRuntimeStage();
    const healthcheckInstructions = runtimeStage.instructions.HEALTHCHECK || [];

    expect(healthcheckInstructions.length).toBeGreaterThan(0);

    const healthcheck = healthcheckInstructions[0]!;
    expect(healthcheck).toContain("/health/ready");
    expect(healthcheck).toContain("curl");
  });

  it("creates non-root user", () => {
    const runtimeStage = getRuntimeStage();
    const runInstructions = runtimeStage.instructions.RUN || [];

    const createsUser = runInstructions.some(
      (run) => run.toLowerCase().includes("useradd") || run.toLowerCase().includes("groupadd"),
    );
    expect(createsUser).toBe(true);
  });

  it("runs application with non-root user (via chown)", () => {
    const runtimeStage = getRuntimeStage();
    const copyInstructions = runtimeStage.instructions.COPY || [];

    const hasChown = copyInstructions.some(
      (copy) => copy.includes("--chown") || copy.includes("cartethyia:cartethyia"),
    );
    expect(hasChown).toBe(true);
  });

  it("copies entrypoint script to runtime stage", () => {
    const runtimeStage = getRuntimeStage();
    const copyInstructions = runtimeStage.instructions.COPY || [];

    const hasEntrypointCopy = copyInstructions.some(
      (copy) => copy.includes("entrypoint") || copy.includes("docker-entrypoint"),
    );
    expect(hasEntrypointCopy).toBe(true);
  });

  it("sets ENTRYPOINT to entrypoint script", () => {
    const runtimeStage = getRuntimeStage();
    const entrypointInstructions = runtimeStage.instructions.ENTRYPOINT || [];

    expect(entrypointInstructions.length).toBeGreaterThan(0);
    expect(entrypointInstructions[0]).toContain("entrypoint");
  });

  it("entrypoint script handles bind mount permissions", () => {
    expect(entrypointContent).toContain("id -u");
    expect(entrypointContent).toContain("0");
    expect(entrypointContent).toContain("chown");
  });

  it("entrypoint script uses exec for signal propagation", () => {
    expect(entrypointContent).toContain("exec");
  });

  it(".dockerignore excludes the root test tree without excluding runtime source", () => {
    expect(dockerignoreContent).toContain("test");
    expect(dockerignoreContent).not.toContain("src/**/*.test.ts");
    expect(dockerignoreContent.split(/\r?\n/)).not.toContain("src");
  });

  it(".dockerignore excludes node_modules", () => {
    expect(dockerignoreContent).toContain("node_modules");
  });

  it(".dockerignore excludes test files", () => {
    expect(dockerignoreContent).toContain("test");
  });

  it(".dockerignore excludes development files", () => {
    expect(dockerignoreContent).toContain(".git");
    expect(dockerignoreContent).toContain(".env");
  });

  it("builder stage runs AOT compilation", () => {
    const builderStage = stages.find((s) => s.name === "builder");
    const runInstructions = builderStage?.instructions.RUN || [];

    const runsAot = runInstructions.some((run) => run.includes("build:aot"));
    expect(runsAot).toBe(true);
  });

  it("builder stage compiles to binary with bytecode", () => {
    const builderStage = stages.find((s) => s.name === "builder");
    const runInstructions = builderStage?.instructions.RUN || [];

    const compilesWithBytecode = runInstructions.some(
      (run) =>
        run.includes("build --compile") && run.includes("--bytecode") && run.includes("--minify"),
    );
    expect(compilesWithBytecode).toBe(true);
  });

  it("builder stage installs the locked dependency graph", () => {
    const builderStage = stages.find((s) => s.name === "builder");
    const runInstructions = builderStage?.instructions.RUN || [];

    const installsLockedDeps = runInstructions.some(
      (run) => run.includes("bun install") && run.includes("--frozen-lockfile"),
    );
    expect(installsLockedDeps).toBe(true);
  });

  it("builder stage copies drizzle migrations", () => {
    const builderStage = stages.find((s) => s.name === "builder");
    const copyInstructions = builderStage?.instructions.COPY || [];

    const hasMigrationsCopy = copyInstructions.some((copy) => copy.includes("drizzle"));
    expect(hasMigrationsCopy).toBe(true);
  });

  it("builds and copies the matched dashboard assets", () => {
    const builderStage = stages.find((s) => s.name === "builder");
    const builderRuns = builderStage?.instructions.RUN || [];
    const runtimeStage = getRuntimeStage();
    const runtimeCopies = runtimeStage.instructions.COPY || [];

    const builderCopies = builderStage?.instructions.COPY ?? [];
    expect(builderCopies.some((copy) => copy.includes("dashboard"))).toBe(true);
    expect(builderRuns.some((run) => run.includes("dashboard:build"))).toBe(true);
    expect(runtimeCopies.some((copy) => copy.includes("/build/dist/dashboard"))).toBe(true);
  });
});

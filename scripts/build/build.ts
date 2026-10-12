import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..", "..");
const steps = [
  { label: "Dashboard", args: ["run", "dashboard:build"] },
  { label: "AOT", args: ["run", "build:aot"] },
  { label: "Standalone binary", args: ["run", "build:binary"] },
] as const;

for (const step of steps) {
  console.log(`[build] ${step.label}`);
  const child = Bun.spawn(["bun", ...step.args], {
    cwd: projectRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    console.error(`[build] ${step.label} failed with exit code ${exitCode}`);
    process.exitCode = exitCode;
    break;
  }
}

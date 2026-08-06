const run = async (command: string[], cwd = process.cwd()): Promise<string> => {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  // Strip ANSI escape sequences so regexes parse reliably whether or not the
  // child detects a non-TTY pipe (vitest/bun may still emit color codes).
  const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  const output = stripAnsi(`${stdout}\n${stderr}`);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed\n${output}`);
  return output;
};

const backend = await run(["bun", "test", "--coverage", "--timeout", "60000", "test/"]);
const coverage = backend.match(/All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/);
if (!coverage) throw new Error("backend coverage summary was not found");
const functions = Number(coverage[1]);
const lines = Number(coverage[2]);
if (functions < 83.9 || lines < 87.9) throw new Error(`backend coverage regressed: funcs=${functions}, lines=${lines}`);
const backendTests = backend.match(/(\d+) pass/);
if (!backendTests || Number(backendTests[1]) < 625) throw new Error("backend test count regressed below 625");

const dashboard = await run(["bun", "run", "test:ci"], `${process.cwd()}/dashboard`);
const dashboardTests = dashboard.match(/Tests\s+(\d+) passed/);
if (!dashboardTests || Number(dashboardTests[1]) < 152) throw new Error("dashboard test count regressed below 152");

console.log(`maturity gate passed: backend funcs=${functions}%, lines=${lines}%, backend tests=${backendTests[1]}, dashboard tests=${dashboardTests[1]}`);

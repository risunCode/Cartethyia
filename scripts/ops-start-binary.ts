/** Starts the compiled production binary without changing the development workflow. */
export {};

const binary = Bun.file("dist/cartethyia");
if (!(await binary.exists())) {
  throw new Error("dist/cartethyia is missing; run bun run build first");
}

process.env.NODE_ENV ??= "production";
process.env.CARTETHYIA_SERVER_MAX_BODY_BYTES ??= String(8 * 1024 * 1024 * 1024);

const child = Bun.spawn(["dist/cartethyia"], {
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);

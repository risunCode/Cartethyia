import { startServer } from "./middleware/server";

startServer().catch((error: unknown) => {
  console.error("[cartethyia] startup failed", error);
  process.exitCode = 1;
});

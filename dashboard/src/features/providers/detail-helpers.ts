import { ApiError, sanitizeErrorMessage } from "../../lib/api";

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return sanitizeErrorMessage(error.message, "request failed");
  return "request failed";
}

export function selectAccountTestModel<T extends { id: string }>(providerId: string, models: readonly T[]): T | undefined {
  const preferredId = providerId === "codex" ? "gpt-5.4-mini" : null;
  return (preferredId ? models.find((model) => model.id === preferredId) : undefined) ?? models[0];
}

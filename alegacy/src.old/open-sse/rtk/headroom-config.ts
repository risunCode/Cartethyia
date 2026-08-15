import type { HeadroomConfig } from "./headroom";

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(Bun.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), minimum), maximum);
}

function optionalHttpUrl(name: string): string | null {
  const raw = Bun.env[name]?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export const headroomConfig: HeadroomConfig = Object.freeze({
  enabled: Bun.env.CARTETHYIA_HEADROOM_ENABLED === "true",
  url: optionalHttpUrl("CARTETHYIA_HEADROOM_URL"),
  timeoutMs: boundedInteger("CARTETHYIA_HEADROOM_TIMEOUT_MS", 3_000, 250, 10_000),
  compressUserMessages: true,
});

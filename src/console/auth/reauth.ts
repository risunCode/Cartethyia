/** Re-auth: sensitive actions must re-confirm the active password. */

import { ensureSettings } from "../db/repos/settings";
import { verifyPassword } from "./password";

export async function confirmPassword(candidate: string | undefined): Promise<boolean> {
  if (!candidate) return false;
  const settings = await ensureSettings();
  if (!settings.passwordHash) return false;
  return verifyPassword(candidate, settings.passwordHash);
}

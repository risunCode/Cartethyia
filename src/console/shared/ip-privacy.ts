import type { PreferencesReader } from "../../persistence/tenant-preferences";

/** IP addresses stay masked unless the tenant explicitly opts into full display. */
export async function shouldMaskClientIp(
  preferences: PreferencesReader,
  tenantId: string,
): Promise<boolean> {
  try {
    const settings = await preferences.readPreferences(tenantId);
    return settings?.privacyMode !== "full";
  } catch {
    return true;
  }
}

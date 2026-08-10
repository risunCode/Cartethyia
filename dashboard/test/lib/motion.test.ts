import { describe, expect, test } from "vitest";
import { getDialogMotion, getPageTransition, resolveMotionProfile } from "../../src/lib/motion";

describe("motion profiles", () => {
  test("uses the max profile for high-end desktop hardware", () => {
    expect(resolveMotionProfile({ reducedMotion: false, mobile: false, saveData: false, deviceMemory: 16, hardwareConcurrency: 12 })).toBe("max");
    expect(getPageTransition("max").transition.duration).toBeGreaterThan(getPageTransition("desktop").transition.duration);
  });

  test("uses the desktop profile for capable pointer devices", () => {
    expect(resolveMotionProfile({ reducedMotion: false, mobile: false, saveData: false, deviceMemory: 8, hardwareConcurrency: 4 })).toBe("desktop");
    expect(getPageTransition("desktop").transition.duration).toBeGreaterThan(getPageTransition("mobile").transition.duration);
  });

  test("lowers motion on mobile and constrained devices", () => {
    expect(resolveMotionProfile({ reducedMotion: false, mobile: true, saveData: false })).toBe("mobile");
    expect(resolveMotionProfile({ reducedMotion: false, mobile: false, saveData: true, deviceMemory: 16, hardwareConcurrency: 12 })).toBe("mobile");
    expect(resolveMotionProfile({ reducedMotion: false, mobile: false, saveData: false, deviceMemory: 2, hardwareConcurrency: 8 })).toBe("mobile");
  });

  test("always disables movement when reduced motion is requested by the system", () => {
    expect(resolveMotionProfile({ reducedMotion: true, mobile: false, saveData: false })).toBe("reduced");
    expect(resolveMotionProfile({ reducedMotion: true, mobile: false, saveData: false, deviceMemory: 16, hardwareConcurrency: 12 })).toBe("reduced");
    expect(getPageTransition("reduced").transition.duration).toBe(0);
    expect(getDialogMotion("reduced").panel.transition.duration).toBe(0);
  });

  test("gives modal close motion the selected profile", () => {
    expect(getDialogMotion("mobile").panel.transition.duration).toBeLessThan(getDialogMotion("desktop").panel.transition.duration);
    expect(getDialogMotion("max").panel.transition.duration).toBeGreaterThan(getDialogMotion("desktop").panel.transition.duration);
  });
});

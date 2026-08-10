import { describe, expect, test } from "vitest";
import { getExitDuration, resolveMotionProfile } from "../../src/lib/motion";

describe("motion profiles", () => {
  test("uses the max profile for high-end desktop hardware", () => {
    expect(resolveMotionProfile({ reducedMotion: false, mobile: false, saveData: false, deviceMemory: 16, hardwareConcurrency: 12 })).toBe("max");
    expect(getExitDuration("max")).toBeGreaterThan(getExitDuration("desktop"));
  });

  test("uses the desktop profile for capable pointer devices", () => {
    expect(resolveMotionProfile({ reducedMotion: false, mobile: false, saveData: false, deviceMemory: 8, hardwareConcurrency: 4 })).toBe("desktop");
    expect(getExitDuration("desktop")).toBeGreaterThan(getExitDuration("mobile"));
  });

  test("lowers motion on mobile and constrained devices", () => {
    expect(resolveMotionProfile({ reducedMotion: false, mobile: true, saveData: false })).toBe("mobile");
    expect(resolveMotionProfile({ reducedMotion: false, mobile: false, saveData: true, deviceMemory: 16, hardwareConcurrency: 12 })).toBe("mobile");
    expect(resolveMotionProfile({ reducedMotion: false, mobile: false, saveData: false, deviceMemory: 2, hardwareConcurrency: 8 })).toBe("mobile");
  });

  test("always disables movement when reduced motion is requested by the system", () => {
    expect(resolveMotionProfile({ reducedMotion: true, mobile: false, saveData: false })).toBe("reduced");
    expect(resolveMotionProfile({ reducedMotion: true, mobile: false, saveData: false, deviceMemory: 16, hardwareConcurrency: 12 })).toBe("reduced");
    expect(getExitDuration("reduced")).toBe(0);
  });
});

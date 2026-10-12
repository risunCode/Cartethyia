import { describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import { EffortPicker } from "../../src/features/studio/EffortPicker";
import { mount } from "../helpers/render";

describe("EffortPicker", () => {
  test("cycles through efforts from High using one tap button", async () => {
    function ControlledPicker() {
      const [effort, setEffort] = useState<"auto" | "low" | "medium" | "high" | "max">("high");
      return createElement(EffortPicker, { value: effort, onChange: setEffort });
    }

    const view = await mount(createElement(ControlledPicker));
    const picker = () => view.find('button[aria-label^="Reasoning effort"]');
    const efforts = ["High", "Max", "Auto", "Low", "Medium", "High"];

    for (const [index, effort] of efforts.entries()) {
      expect(picker()?.textContent).toBe(effort);
      if (index < efforts.length - 1) {
        await view.click('button[aria-label^="Reasoning effort"]');
      }
    }
    view.unmount();
  });
});

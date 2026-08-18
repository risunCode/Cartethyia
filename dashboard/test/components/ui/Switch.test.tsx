import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { Switch } from "../../../src/components/ui/switch";

describe("Switch", () => {
  test("renders as a switch with an accessible label", () => {
    render(() => <Switch checked={false} onChange={() => {}} label="Activate account" />);

    const control = screen.getByRole("switch", { name: "Activate account" });
    expect(control).toBeInTheDocument();
    expect(control).not.toBeChecked();
  });

  test("reflects the checked state through aria-checked", () => {
    const [checked, setChecked] = createSignal(true);
    render(() => <Switch checked={checked()} onChange={setChecked} label="Toggle" />);

    const control = screen.getByRole("switch", { name: "Toggle" });
    expect(control).toBeChecked();
  });

  test("toggles the value on click and reports through onChange", () => {
    const onChange = vi.fn();
    render(() => <Switch checked={false} onChange={onChange} label="Activate account" />);

    const control = screen.getByRole("switch", { name: "Activate account" });
    fireEvent.click(control);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  test("toggles from on to off", () => {
    const onChange = vi.fn();
    render(() => <Switch checked={true} onChange={onChange} label="Activate account" />);

    fireEvent.click(screen.getByRole("switch", { name: "Activate account" }));

    expect(onChange).toHaveBeenCalledWith(false);
  });

  test("does not fire onChange when disabled", () => {
    const onChange = vi.fn();
    render(() => <Switch checked={false} onChange={onChange} disabled label="Locked" />);

    const control = screen.getByRole("switch", { name: "Locked" });
    expect(control).toBeDisabled();
    fireEvent.click(control);

    expect(onChange).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { Dropdown, type DropdownOption } from "../../../src/components/forms/Dropdown";

const options: readonly DropdownOption[] = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta", description: "Second choice" },
  { value: "gamma", label: "Gamma", disabled: true },
];

// jsdom ships no Web Animations implementation; the overlay lifecycle runs a
// 180ms fade when closing, so give it a no-op animation to drive.
beforeEach(() => {
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() })),
  });
});

afterEach(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
  vi.restoreAllMocks();
});

// Flipping `open` re-invokes the primitive's trigger render prop, which
// replaces the trigger node; always re-query instead of holding references.
function openMenu() {
  fireEvent.click(screen.getByRole("combobox"));
  const trigger = screen.getByRole("combobox");
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  return trigger;
}

async function expectMenuClosed() {
  await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
  expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "false");
}

describe("Dropdown", () => {
  test("shows the selected option label, or the placeholder when nothing matches", () => {
    const { unmount } = render(() => <Dropdown value="beta" onChange={() => {}} options={options} />);
    expect(screen.getByRole("combobox")).toHaveTextContent("Beta");
    unmount();

    render(() => <Dropdown value="" onChange={() => {}} options={options} placeholder="Pick one" />);
    expect(screen.getByRole("combobox")).toHaveTextContent("Pick one");
  });

  test("opens and closes the menu from the trigger", async () => {
    render(() => <Dropdown value="" onChange={() => {}} options={options} />);
    const trigger = openMenu();

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);

    fireEvent.click(trigger);
    await expectMenuClosed();
  });

  test("selects an option with the mouse and reports it through onChange", async () => {
    const onChange = vi.fn();
    render(() => <Dropdown value="" onChange={onChange} options={options} />);
    openMenu();

    fireEvent.click(screen.getByRole("option", { name: /beta/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("beta");
    await expectMenuClosed();
  });

  test("selects an option with Enter and Space keys", async () => {
    const onChange = vi.fn();
    render(() => <Dropdown value="" onChange={onChange} options={options} />);
    openMenu();

    fireEvent.keyDown(screen.getByRole("option", { name: "Alpha" }), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("alpha");
    await expectMenuClosed();

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.keyDown(screen.getByRole("option", { name: "Alpha" }), { key: " " });
    expect(onChange).toHaveBeenCalledTimes(2);
    await expectMenuClosed();
  });

  test("ignores clicks and keys on disabled options and keeps the menu open", () => {
    const onChange = vi.fn();
    render(() => <Dropdown value="" onChange={onChange} options={options} />);
    openMenu();

    const disabled = screen.getByRole("option", { name: "Gamma" });
    expect(disabled).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(disabled);
    fireEvent.keyDown(disabled, { key: "Enter" });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  test("marks the selected option with aria-selected and a check glyph", () => {
    render(() => <Dropdown value="beta" onChange={() => {}} options={options} />);
    openMenu();

    expect(screen.getByRole("option", { name: /beta/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Alpha" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("option", { name: /beta/i }).querySelector("svg")).not.toBeNull();  });

  test("closes the menu on Escape", async () => {
    render(() => <Dropdown value="" onChange={() => {}} options={options} />);
    openMenu();

    fireEvent.keyDown(window, { key: "Escape" });

    await expectMenuClosed();
  });

  test("renders an empty state when there are no options", () => {
    render(() => <Dropdown value="" onChange={() => {}} options={[]} placeholder="Nothing here" />);
    openMenu();

    expect(screen.getByText("No options available")).toBeInTheDocument();
  });

  test("exposes combobox semantics on the trigger", () => {
    render(() => <Dropdown value="" onChange={() => {}} options={options} ariaLabel="Pick a channel" />);

    const trigger = screen.getByRole("combobox", { name: "Pick a channel" });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls", expect.any(String));
  });

  test("disables the whole control when disabled is set", () => {
    render(() => <Dropdown value="" onChange={() => {}} options={options} disabled />);

    const trigger = screen.getByRole("combobox");
    expect(trigger).toBeDisabled();

    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});


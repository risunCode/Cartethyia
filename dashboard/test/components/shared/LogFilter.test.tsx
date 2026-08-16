import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { LogFilter, type LogLevel } from "../../../src/components/shared/LogFilter";

describe("LogFilter", () => {
  test("renders every level chip with the current level checked", () => {
    render(() => <LogFilter level="all" onLevelChange={() => {}} />);

    const group = screen.getByRole("radiogroup", { name: "Minimum log level" });
    expect(group).toBeInTheDocument();
    const chips = screen.getAllByRole("radio");
    expect(chips.map((chip) => chip.textContent)).toEqual(["All", "Debug", "Info", "Warn", "Error"]);
    expect(screen.getByRole("radio", { name: "All" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Error" })).not.toBeChecked();
  });

  test("reports level changes through onLevelChange", () => {
    const onLevelChange = vi.fn();
    render(() => <LogFilter level="info" onLevelChange={onLevelChange} />);

    fireEvent.click(screen.getByRole("radio", { name: "Error" }));

    expect(onLevelChange).toHaveBeenCalledTimes(1);
    expect(onLevelChange).toHaveBeenCalledWith("error");
  });

  test("moves the checked chip when the controlled level changes", () => {
    const [level, setLevel] = createSignal<LogLevel>("all");
    render(() => <LogFilter level={level()} onLevelChange={setLevel} />);

    fireEvent.click(screen.getByRole("radio", { name: "Warn" }));

    expect(level()).toBe("warn");
    expect(screen.getByRole("radio", { name: "Warn" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "All" })).not.toBeChecked();
  });

  test("forwards source input changes through onSourceChange", () => {
    const onSourceChange = vi.fn();
    render(() => <LogFilter level="all" onLevelChange={() => {}} source="" onSourceChange={onSourceChange} />);

    const input = screen.getByLabelText("Source");
    expect(input).toHaveValue("");

    fireEvent.input(input, { target: { value: "proxy.core" } });

    expect(onSourceChange).toHaveBeenCalledTimes(1);
    expect(onSourceChange).toHaveBeenCalledWith("proxy.core");
  });

  test("hides the source input when no onSourceChange handler is supplied", () => {
    render(() => <LogFilter level="all" onLevelChange={() => {}} />);

    expect(screen.queryByLabelText("Source")).not.toBeInTheDocument();
  });

  test("exposes the whole control as a labelled toolbar", () => {
    render(() => <LogFilter level="all" onLevelChange={() => {}} />);

    expect(screen.getByRole("toolbar", { name: "Console log filters" })).toBeInTheDocument();
  });
});


import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import ConsoleLog from "../../../src/pages/ConsoleLog/index";

vi.mock("../../../src/components/shared/LogHistory", () => ({
  LogHistory: (props: { level: string; source: string }) => (
    <div data-testid="log-history-stub" data-level={props.level} data-source={props.source} />
  ),
}));

describe("ConsoleLog page", () => {
  test("renders the heading, filters, and history by default", () => {
    render(() => <ConsoleLog />);

    expect(screen.getByRole("heading", { level: 2, name: "Console Log" })).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "Console log filters" })).toBeInTheDocument();

    expect(screen.getByTestId("log-history-stub")).toBeInTheDocument();
  });

  test("maps the 'all' chip to the debug floor and passes explicit levels down", () => {
    render(() => <ConsoleLog />);

    const history = screen.getByTestId("log-history-stub");
    expect(history).toHaveAttribute("data-level", "debug");

    fireEvent.click(screen.getByRole("radio", { name: "Error" }));
    expect(screen.getByTestId("log-history-stub")).toHaveAttribute("data-level", "error");

    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(screen.getByTestId("log-history-stub")).toHaveAttribute("data-level", "debug");
  });

  test("forwards the source filter into the active pane", () => {
    render(() => <ConsoleLog />);

    fireEvent.input(screen.getByLabelText("Source"), { target: { value: "proxy.core" } });

    expect(screen.getByTestId("log-history-stub")).toHaveAttribute("data-source", "proxy.core");
  });
});


import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import ConsoleLog from "../../../src/pages/ConsoleLog/index";

// The live pane opens an EventSource and the history pane fetches from the
// API; both are stubbed so the page shell itself stays under test.
vi.mock("../../../src/components/shared/LogStream", () => ({
  LogStream: (props: { url: string; level: string; source: string }) => (
    <div data-testid="log-stream-stub" data-url={props.url} data-level={props.level} data-source={props.source} />
  ),
}));

vi.mock("../../../src/components/shared/LogHistory", () => ({
  LogHistory: (props: { level: string; source: string }) => (
    <div data-testid="log-history-stub" data-level={props.level} data-source={props.source} />
  ),
}));

describe("ConsoleLog page", () => {
  test("renders the heading, filters, and live tab by default", () => {
    render(() => <ConsoleLog />);

    expect(screen.getByRole("heading", { level: 2, name: "Console Log" })).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "Console log filters" })).toBeInTheDocument();

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Live stream", "History"]);
    expect(screen.getByRole("tab", { name: "Live stream" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "false");

    const stream = screen.getByTestId("log-stream-stub");
    expect(stream).toBeInTheDocument();
    expect(stream).toHaveAttribute("data-url", "/v2/admin/console/logs/stream");
    expect(screen.queryByTestId("log-history-stub")).not.toBeInTheDocument();
  });

  test("switches between the live and history panes", () => {
    render(() => <ConsoleLog />);

    fireEvent.click(screen.getByRole("tab", { name: "History" }));

    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Live stream" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("log-history-stub")).toBeInTheDocument();
    expect(screen.queryByTestId("log-stream-stub")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Live stream" }));

    expect(screen.getByTestId("log-stream-stub")).toBeInTheDocument();
    expect(screen.queryByTestId("log-history-stub")).not.toBeInTheDocument();
  });

  test("maps the 'all' chip to the debug floor and passes explicit levels down", () => {
    render(() => <ConsoleLog />);

    const stream = screen.getByTestId("log-stream-stub");
    expect(stream).toHaveAttribute("data-level", "debug");

    fireEvent.click(screen.getByRole("radio", { name: "Error" }));
    expect(screen.getByTestId("log-stream-stub")).toHaveAttribute("data-level", "error");

    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(screen.getByTestId("log-stream-stub")).toHaveAttribute("data-level", "debug");
  });

  test("forwards the source filter into the active pane", () => {
    render(() => <ConsoleLog />);

    fireEvent.input(screen.getByLabelText("Source"), { target: { value: "proxy.core" } });

    expect(screen.getByTestId("log-stream-stub")).toHaveAttribute("data-source", "proxy.core");

    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByTestId("log-history-stub")).toHaveAttribute("data-source", "proxy.core");
  });
});


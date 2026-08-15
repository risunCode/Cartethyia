import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { StatePanel, StatCard } from "../../../src/components/ui/state";

describe("dashboard state primitives", () => {
  test("renders loading, empty, error, and degraded states with semantic status", () => {
    const { rerender } = render(<StatePanel kind="loading" title="Loading providers" />);
    expect(screen.getByRole("status")).toHaveTextContent("Please wait");
    rerender(<StatePanel kind="empty" title="No providers" />);
    expect(screen.getByText("No providers")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("There is no data");
    rerender(<StatePanel kind="error" title="Provider failure" />);
    expect(screen.getByText("Provider failure")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Try again or check the connection");
    rerender(<StatePanel kind="degraded" title="Catalog unavailable" />);
    expect(screen.getByRole("status")).toHaveTextContent("capability is currently degraded");
  });

  test("renders a semantic loading placeholder for stat cards", () => {
    render(<StatCard label="Requests" value="0" loading />);
    expect(screen.getByLabelText("Loading Requests")).toBeInTheDocument();
  });
});

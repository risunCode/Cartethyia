import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InlineModelBrowser, ModelPickerField, ModelTargetPicker } from "./model-picker";

function withQueryClient(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("InlineModelBrowser", () => {
  test("renders the search input in providers mode", () => {
    render(withQueryClient(<InlineModelBrowser mode="providers" selected={[]} onToggle={vi.fn()} />));
    expect(screen.getByPlaceholderText("Search providers\u2026")).toBeInTheDocument();
  });

  test("renders the search input in models mode", () => {
    render(withQueryClient(<InlineModelBrowser mode="models" selected={[]} onToggle={vi.fn()} />));
    expect(screen.getByPlaceholderText("Search models\u2026")).toBeInTheDocument();
  });

  test("shows an 'Add' button when the search box has non-empty text", async () => {
    const onToggle = vi.fn();
    render(withQueryClient(<InlineModelBrowser mode="models" selected={[]} onToggle={onToggle} />));
    const input = screen.getByPlaceholderText("Search models\u2026");
    fireEvent.change(input, { target: { value: "my-custom-model" } });
    expect(screen.getByRole("button", { name: /Add "my-custom-model"/ })).toBeInTheDocument();
  });

  test("clicking the add button calls onToggle with the search value", async () => {
    const onToggle = vi.fn();
    render(withQueryClient(<InlineModelBrowser mode="models" selected={[]} onToggle={onToggle} />));
    const input = screen.getByPlaceholderText("Search models\u2026");
    fireEvent.change(input, { target: { value: "custom-model" } });
    fireEvent.click(screen.getByRole("button", { name: /Add "custom-model"/ }));
    expect(onToggle).toHaveBeenCalledWith("custom-model");
  });

  test("pressing Enter in the search box adds the value via onToggle", () => {
    const onToggle = vi.fn();
    render(withQueryClient(<InlineModelBrowser mode="models" selected={[]} onToggle={onToggle} />));
    const input = screen.getByPlaceholderText("Search models\u2026");
    fireEvent.change(input, { target: { value: "enter-model" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onToggle).toHaveBeenCalledWith("enter-model");
  });

  test("does not show the add button when the search box is empty", () => {
    render(withQueryClient(<InlineModelBrowser mode="models" selected={[]} onToggle={vi.fn()} />));
    expect(screen.queryByRole("button", { name: /Add/ })).not.toBeInTheDocument();
  });

  test("does not show the add button when the search value is already selected", () => {
    render(withQueryClient(<InlineModelBrowser mode="models" selected={["already-selected"]} onToggle={vi.fn()} />));
    const input = screen.getByPlaceholderText("Search models\u2026");
    fireEvent.change(input, { target: { value: "already-selected" } });
    expect(screen.queryByRole("button", { name: /Add/ })).not.toBeInTheDocument();
  });
});

describe("ModelTargetPicker — search + select interaction", () => {
  test("the inline browser search input is present alongside the value input", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelTargetPicker value="gpt-4o" onChange={onChange} />));
    expect(screen.getByDisplayValue("gpt-4o")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search models\u2026")).toBeInTheDocument();
  });

  test("typing in the target input calls onChange", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelTargetPicker value="" onChange={onChange} placeholder="Pick a model" />));
    fireEvent.change(screen.getByPlaceholderText("Pick a model"), { target: { value: "new-model" } });
    expect(onChange).toHaveBeenCalledWith("new-model");
  });
});

describe("ModelPickerField — search + add-from-search interaction", () => {
  test("typing in the search box shows the add button for a new value", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Models" values={[]} onChange={onChange} mode="models" />));
    fireEvent.change(screen.getByPlaceholderText("Search models\u2026"), { target: { value: "new-entry" } });
    expect(screen.getByRole("button", { name: /Add "new-entry"/ })).toBeInTheDocument();
  });

  test("clicking the add button toggles the value into the list", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Models" values={[]} onChange={onChange} mode="models" />));
    fireEvent.change(screen.getByPlaceholderText("Search models\u2026"), { target: { value: "new-entry" } });
    fireEvent.click(screen.getByRole("button", { name: /Add "new-entry"/ }));
    expect(onChange).toHaveBeenCalledWith(["new-entry"]);
  });
});

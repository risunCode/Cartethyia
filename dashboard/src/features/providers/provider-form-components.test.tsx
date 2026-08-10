import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModelTargetPicker, ModelPickerField } from "../../components/model-picker";
import { withQueryClient } from "../../test/query-client";
// These components are the "provider-form" building blocks used in the
// provider detail page, key ACL fields, combo forms, and alias fields.
// Testing them here with their own render assertions covers the provider-form
// component coverage gap without needing to mount the entire 1000-line
// ProviderDetailPage (which requires full react-router + route params).

describe("ModelTargetPicker \u2014 single-value form field", () => {
  test("renders an input with the current value", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelTargetPicker value="gpt-4o" onChange={onChange} />));
    expect(screen.getByDisplayValue("gpt-4o")).toBeInTheDocument();
  });

  test("renders a placeholder when value is empty", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelTargetPicker value="" onChange={onChange} placeholder="Pick a model" />));
    expect(screen.getByPlaceholderText("Pick a model")).toBeInTheDocument();
  });

  test("renders the inline browser search input", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelTargetPicker value="" onChange={onChange} />));
    expect(screen.getByPlaceholderText("Search models\u2026")).toBeInTheDocument();
  });

  test("is not disabled by default", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelTargetPicker value="" onChange={onChange} placeholder="Pick a model" />));
    const input = screen.getByPlaceholderText("Pick a model") as HTMLInputElement;
    expect(input.disabled).toBe(false);
  });

  test("is disabled when the disabled prop is true", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelTargetPicker value="x" onChange={onChange} disabled />));
    const input = screen.getByDisplayValue("x") as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});

describe("ModelPickerField \u2014 multi-value form field", () => {
  test("renders a chip for each value with a remove button", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Allowed models" values={["openai/gpt-4o", "anthropic/claude-3"]} onChange={onChange} mode="models" />));
    // Chips render as <span> parents with the model id inside, alongside a remove button.
    // Use getAllByText since the value also appears in the inline browser's custom entries.
    expect(screen.getAllByText("openai/gpt-4o").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("anthropic/claude-3").length).toBeGreaterThanOrEqual(1);
    // The remove buttons are the ones with aria-label starting with "Remove ".
    expect(screen.getAllByRole("button", { name: /Remove / })).toHaveLength(2);
  });

  test("clicking the remove button on a chip calls onChange without that value", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Providers" values={["openai", "anthropic"]} onChange={onChange} mode="providers" />));
    fireEvent.click(screen.getByRole("button", { name: "Remove openai" }));
    expect(onChange).toHaveBeenCalledWith(["anthropic"]);
  });

  test("renders an empty state (no chips) when values is empty", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Models" values={[]} onChange={onChange} mode="models" />));
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  });

  test("renders the label and optional hint", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Allowed" hint="leave empty for all" values={[]} onChange={onChange} mode="providers" />));
    expect(screen.getByText("Allowed")).toBeInTheDocument();
    expect(screen.getByText("leave empty for all")).toBeInTheDocument();
  });

  test("renders the search input for the inline browser", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Models" values={[]} onChange={onChange} mode="models" />));
    expect(screen.getByPlaceholderText("Search models\u2026")).toBeInTheDocument();
  });
});

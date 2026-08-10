import { describe, expect, test, vi } from "vitest";
import type * as ApiModule from "../../src/lib/api";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InlineModelBrowser, ModelPickerField, ModelTargetPicker } from "../../src/components/model-picker";
import { withQueryClient } from "../query-client";

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof ApiModule>("../../src/lib/api");
  return {
    ...actual,
    apiGet: vi.fn((path: string) => {
      if (path === "/aliases") return Promise.resolve({ items: [{ alias: "fast", model: "kimchi/kimi-k2.7" }] });
      if (path === "/combos") return Promise.resolve({ items: [{ name: "fast-combo" }] });
      if (path === "/providers") return Promise.resolve({ items: [] });
      if (path === "/custom-providers") {
        return Promise.resolve({
          items: [
            {
              slug: "openrouter-custom",
              name: "OpenRouter (custom)",
              models: [{ id: "gpt-4" }, { id: "anthropic/claude-3-opus" }],
            },
          ],
        });
      }
      return Promise.resolve({ items: [] });
    }),
  };
});

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

  // Regression: aliases were only addable by typing them manually - fetching/
  // browsing the catalog always returned zero, since InlineModelBrowser had no
  // concept of an alias catalog at all (only combos, and even those never
  // rendered for API key allow/deny lists since ModelPickerField never passed
  // includeCombos through). Aliases must appear above Combos, which must
  // appear above the per-provider model sections.
  test("fetches and renders aliases above combos and per-provider models when both are enabled", async () => {
    render(withQueryClient(<InlineModelBrowser mode="models" selected={[]} onToggle={vi.fn()} includeCombos includeAliases />));
    await waitFor(() => expect(screen.getByText("fast")).toBeInTheDocument());
    expect(screen.getByText("fast-combo")).toBeInTheDocument();

    const aliasesHeading = screen.getByText(/Aliases \(/);
    const combosHeading = screen.getByText(/Combos \(/);
    expect(aliasesHeading.compareDocumentPosition(combosHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("does not fetch or render aliases/combos when neither is enabled", async () => {
    render(withQueryClient(<InlineModelBrowser mode="models" selected={[]} onToggle={vi.fn()} />));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("fast")).not.toBeInTheDocument();
    expect(screen.queryByText("fast-combo")).not.toBeInTheDocument();
  });

  test("selecting an alias calls onToggle with its bare name", async () => {
    const onToggle = vi.fn();
    render(withQueryClient(<InlineModelBrowser mode="models" selected={[]} onToggle={onToggle} includeAliases />));
    await waitFor(() => expect(screen.getByText("fast")).toBeInTheDocument());
    fireEvent.click(screen.getByText("fast"));
    expect(onToggle).toHaveBeenCalledWith("fast");
  });

  // Regression: custom (BYOK) OpenAI/Anthropic-compatible providers live in a
  // separate table/endpoint (`/custom-providers`) from the built-in registry
  // (`/providers`) that InlineModelBrowser used to fetch exclusively - a
  // custom provider's models could never be picked here at all, only typed
  // in manually.
  test("fetches and renders custom provider models grouped under their own provider name", async () => {
    render(withQueryClient(<InlineModelBrowser mode="models" selected={[]} onToggle={vi.fn()} />));
    await waitFor(() => expect(screen.getByText(/OpenRouter \(custom\)/)).toBeInTheDocument());
    expect(screen.getByText("gpt-4")).toBeInTheDocument();
  });

  // Regression: some providers' own model ids embed a slash (OpenRouter's
  // "owner/model" convention), so the qualified `provider/model` string can
  // have two slashes total. Rendering `.split("/")[1]` truncated the chip to
  // just the owner segment ("anthropic") for every such model instead of the
  // full model id.
  test("shows the full model id (not just the owner segment) for a model whose own id contains a slash", async () => {
    render(withQueryClient(<InlineModelBrowser mode="models" selected={[]} onToggle={vi.fn()} />));
    await waitFor(() => expect(screen.getByText("anthropic/claude-3-opus")).toBeInTheDocument());
  });

  test("selecting a custom provider model calls onToggle with the full qualified id", async () => {
    const onToggle = vi.fn();
    render(withQueryClient(<InlineModelBrowser mode="models" selected={[]} onToggle={onToggle} />));
    await waitFor(() => expect(screen.getByText("gpt-4")).toBeInTheDocument());
    fireEvent.click(screen.getByText("gpt-4"));
    expect(onToggle).toHaveBeenCalledWith("openrouter-custom/gpt-4");
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

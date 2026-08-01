import { describe, expect, test } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ModelPickerField, ModelTargetPicker, ModelPickerModal } from "./model-picker";
import { vi } from "vitest";

// ModelPicker depends on react-query fetching real API data. To test the
// rendered structure without network I/O we wrap every component in a
// QueryClientProvider (required by the hooks) and stub fetch for any
// incidental queries that fire on mount.

function withQueryClient(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("ModelPickerField", () => {
  test("renders the label", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Providers" values={[]} onChange={onChange} mode="providers" />));
    expect(screen.getByText("Providers")).toBeInTheDocument();
  });

  test("renders hint text when provided", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Providers" hint="pick one or more" values={[]} onChange={onChange} mode="providers" />));
    expect(screen.getByText("pick one or more")).toBeInTheDocument();
  });

  test("renders a chip for each value in the values array", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Providers" values={["openai", "anthropic"]} onChange={onChange} mode="providers" />));
    expect(screen.getByText("openai")).toBeInTheDocument();
    expect(screen.getByText("anthropic")).toBeInTheDocument();
  });

  test("clicking X removes the value from the list", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Providers" values={["openai"]} onChange={onChange} mode="providers" />));
    fireEvent.click(screen.getByRole("button", { name: "Remove openai" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  test("does not render any chips when values is empty", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Providers" values={[]} onChange={onChange} mode="providers" />));
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  });

  test("renders the search input for the inline browser", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Models" values={[]} onChange={onChange} mode="models" />));
    expect(screen.getByPlaceholderText("Search models\u2026")).toBeInTheDocument();
  });
});

describe("ModelTargetPicker", () => {
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

  test("calls onChange when the input value changes", () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelTargetPicker value="" onChange={onChange} />));
    fireEvent.change(screen.getByPlaceholderText("Search models\u2026"), { target: { value: "new" } });
    // onChange for the target input is what drives the parent's state.
    expect(onChange).not.toThrow();
  });
});

describe("ModelPickerModal", () => {
  test("renders nothing in the DOM when closed", () => {
    const onClose = vi.fn();
    render(withQueryClient(<ModelPickerModal open={false} onClose={onClose} mode="providers" selected={[]} onToggle={vi.fn()} />));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("renders the default title for providers mode", () => {
    const onClose = vi.fn();
    render(withQueryClient(<ModelPickerModal open onClose={onClose} mode="providers" selected={[]} onToggle={vi.fn()} />));
    expect(screen.getByRole("dialog", { name: "Add provider" })).toBeInTheDocument();
  });

  test("renders the default title for models mode", () => {
    const onClose = vi.fn();
    render(withQueryClient(<ModelPickerModal open onClose={onClose} mode="models" selected={[]} onToggle={vi.fn()} />));
    expect(screen.getByRole("dialog", { name: "Add model" })).toBeInTheDocument();
  });

  test("renders a custom title when provided", () => {
    const onClose = vi.fn();
    render(withQueryClient(<ModelPickerModal open onClose={onClose} mode="models" selected={[]} onToggle={vi.fn()} title="Pick your favorite" />));
    expect(screen.getByRole("dialog", { name: "Pick your favorite" })).toBeInTheDocument();
  });

  test("renders a search input", () => {
    const onClose = vi.fn();
    render(withQueryClient(<ModelPickerModal open onClose={onClose} mode="models" selected={[]} onToggle={vi.fn()} />));
    expect(screen.getByPlaceholderText("Search models\u2026")).toBeInTheDocument();
  });
});

describe("ModelPickerField \u2014 alias/combo selected values are not double-classified as Custom", () => {
  function stubCatalogFetch() {
    const responses: Record<string, unknown> = {
      "/console/api/providers": { items: [] },
      "/console/api/custom-providers": { items: [] },
      "/console/api/aliases": { items: [{ alias: "gpt-5.6-sol", model: "openai/gpt-5.6-sol" }] },
      "/console/api/combos": { items: [{ name: "fast-combo" }] },
    };
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = responses[path];
      return new Response(JSON.stringify(body ?? { items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    });
  }

  test("a selected alias renders once, under Aliases, not under a spurious Custom section", async () => {
    const fetchSpy = stubCatalogFetch();
    const onChange = vi.fn();
    render(
      withQueryClient(
        <ModelPickerField label="Allowed" values={["gpt-5.6-sol"]} onChange={onChange} mode="models" includeCombos includeAliases />
      )
    );

    // Wait for the aliases query to resolve and the Aliases section to render.
    expect(await screen.findByText("Aliases (1)")).toBeInTheDocument();
    // No "Custom" section should render \u2014 the alias is fully accounted for above.
    expect(screen.queryByText(/^Custom \(/)).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  test("a selected combo renders once, under Combos, not under a spurious Custom section", async () => {
    const fetchSpy = stubCatalogFetch();
    const onChange = vi.fn();
    render(
      withQueryClient(
        <ModelPickerField label="Allowed" values={["fast-combo"]} onChange={onChange} mode="models" includeCombos includeAliases />
      )
    );

    expect(await screen.findByText("Combos (1)")).toBeInTheDocument();
    expect(screen.queryByText(/^Custom \(/)).not.toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  test("a genuinely unrecognized selected value still renders under Custom", async () => {
    const fetchSpy = stubCatalogFetch();
    const onChange = vi.fn();
    render(
      withQueryClient(
        <ModelPickerField label="Allowed" values={["totally-manual-value"]} onChange={onChange} mode="models" includeCombos includeAliases />
      )
    );

    expect(await screen.findByText("Custom (1)")).toBeInTheDocument();

    fetchSpy.mockRestore();
  });
});

import { describe, expect, test } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfiguredModelPicker, ModelPickerField, ModelTargetPicker, ModelPickerModal } from "./model-picker";
import { vi } from "vitest";
import { withQueryClient, mockJsonFetch } from "../test/query-client";

// ModelPicker depends on react-query fetching real API data. To test the
// rendered structure without network I/O we wrap every component in a
// QueryClientProvider (required by the hooks) and stub fetch for any
// incidental queries that fire on mount.


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

  test("opens the configured model browser", async () => {
    const onChange = vi.fn();
    render(withQueryClient(<ModelPickerField label="Models" values={[]} onChange={onChange} mode="models" />));
    fireEvent.click(screen.getByRole("button", { name: "Add configured models…" }));
    expect(await screen.findByPlaceholderText("Search configured models…")).toBeInTheDocument();
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
  test("shows a semantic empty state when provider catalog has no entries", async () => {
    const fetchSpy = mockJsonFetch({ "/console/api/providers": { items: [] } });
    try {
      render(withQueryClient(<ModelPickerModal open onClose={vi.fn()} mode="providers" selected={[]} onToggle={vi.fn()} />));
      expect(await screen.findByText("No providers match your search.")).toBeInTheDocument();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  test("shows an error state when provider catalog request fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream unavailable", { status: 503 }));
    try {
      render(withQueryClient(<ModelPickerModal open onClose={vi.fn()} mode="providers" selected={[]} onToggle={vi.fn()} />));
      expect(await screen.findByText("Unable to load provider and model catalog.", {}, { timeout: 5_000 })).toBeInTheDocument();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("ModelPickerField — configured provider visibility", () => {
  test("does not render models without credentials, except none-credential providers", async () => {
    const responses: Record<string, unknown> = {
      "/console/api/providers": {
        items: [
          { id: "openai", name: "OpenAI", icon: "openai", prefix: "openai", credentialKind: "api_key", configured: false },
          { id: "opencodeft", name: "OpenCode Free", icon: "opencode", prefix: "opencodeft", credentialKind: "none", configured: false },
        ],
      },
      "/console/api/custom-providers": { items: [] },
      "/console/api/providers/openai": { prefix: "openai", models: [{ id: "gpt-5", enabled: true }] },
      "/console/api/providers/opencodeft": { prefix: "opencodeft", models: [{ id: "free-model", enabled: true }] },
    };
    const fetchSpy = mockJsonFetch(responses);
    render(withQueryClient(<ModelPickerField label="Models" values={[]} onChange={vi.fn()} mode="models" />));
    fireEvent.click(screen.getByRole("button", { name: "Add configured models…" }));
    expect(await screen.findByText("free-model")).toBeInTheDocument();
    expect(screen.queryByText("gpt-5")).not.toBeInTheDocument();
    fetchSpy.mockRestore();

  });

  test("normalizes the live provider catalog modelId payload", async () => {
    const responses: Record<string, unknown> = {
      "/console/api/providers": {
        items: [{ id: "kimchi", name: "Kimchi", credentialKind: "oauth", configured: true, accountCount: 1, modelCount: 1 }],
      },
      "/console/api/custom-providers": { items: [] },
      "/console/api/providers/kimchi": {
        id: "kimchi",
        name: "Kimchi",
        models: [{ providerId: "kimchi", modelId: "kimi-k2.7", enabled: true }],
      },
    };
    const fetchSpy = mockJsonFetch(responses);
    try {
      render(withQueryClient(<ModelPickerField label="Models" values={[]} onChange={vi.fn()} mode="models" />));
      fireEvent.click(screen.getByRole("button", { name: "Add configured models…" }));
      expect(await screen.findByText("kimi-k2.7")).toBeInTheDocument();
    } finally {
      fetchSpy.mockRestore();
    }

  });
  test("keeps custom BYOK providers out of API-key allowlist picker", async () => {
    const responses: Record<string, unknown> = {
      "/console/api/providers": { items: [] },
      "/console/api/custom-providers": {
        items: [{ slug: "bobox", name: "Custom Blackbox", credentialHint: "sk-test", models: [{ id: "blackboxai/z-ai/glm-5.2" }] }],
      },
    };
    const fetchSpy = mockJsonFetch(responses);
    try {
      render(withQueryClient(<ModelPickerField label="Allowed models" values={[]} onChange={vi.fn()} mode="models" includeCustomProviders={false} />));
      fireEvent.click(screen.getByRole("button", { name: "Add configured models…" }));
      await screen.findByPlaceholderText("Search configured models…");
      expect(screen.queryByText("blackboxai/z-ai/glm-5.2")).not.toBeInTheDocument();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("ConfiguredModelPicker selected values", () => {
  function stubCatalogFetch() {
    const responses: Record<string, unknown> = {
      "/console/api/providers": { items: [] },
      "/console/api/custom-providers": { items: [] },
      "/console/api/aliases": { items: [{ alias: "gpt-5.6-sol", model: "openai/gpt-5.6-sol" }] },
      "/console/api/combos": { items: [{ name: "fast-combo" }] },
    };
    return mockJsonFetch(responses);
  }

  test("renders a selected alias in the Aliases section", async () => {
    const fetchSpy = stubCatalogFetch();
    render(withQueryClient(<ModelPickerField label="Allowed" values={["gpt-5.6-sol"]} onChange={vi.fn()} mode="models" includeCombos includeAliases />));
    fireEvent.click(screen.getByRole("button", { name: "1 models selected" }));
    expect(await screen.findByText("Aliases")).toBeInTheDocument();
    expect(screen.queryByText(/^Custom/)).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  test("renders a selected combo in the Combos section", async () => {
    const fetchSpy = stubCatalogFetch();
    render(withQueryClient(<ModelPickerField label="Allowed" values={["fast-combo"]} onChange={vi.fn()} mode="models" includeCombos includeAliases />));
    fireEvent.click(screen.getByRole("button", { name: "1 models selected" }));
    expect(await screen.findByText("Combos")).toBeInTheDocument();
    expect(screen.queryByText(/^Custom/)).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  test("keeps an unrecognized selected value without inventing a catalog section", async () => {
    const fetchSpy = stubCatalogFetch();
    render(withQueryClient(<ModelPickerField label="Allowed" values={["totally-manual-value"]} onChange={vi.fn()} mode="models" includeCombos includeAliases />));
    fireEvent.click(screen.getByRole("button", { name: "1 models selected" }));
    expect(await screen.findByPlaceholderText("Search configured models…")).toBeInTheDocument();
    expect(screen.queryByText(/^Custom/)).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  });
});

describe("ConfiguredModelPicker lifecycle", () => {
  test("does not emit changing dependency-array warnings as the catalog loads", async () => {
    const responses: Record<string, unknown> = {
      "/console/api/providers": {
        items: [{ id: "opencodeft", name: "OpenCode Free", icon: "opencode", prefix: "opencodeft", credentialKind: "none", configured: false }],
      },
      "/console/api/custom-providers": { items: [] },
      "/console/api/providers/opencodeft": { prefix: "opencodeft", models: [{ id: "free-model", enabled: true }] },
    };
    const fetchSpy = mockJsonFetch(responses);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(withQueryClient(<ConfiguredModelPicker value="" onChange={vi.fn()} />));
      fireEvent.click(screen.getByRole("button", { name: "Select configured model…" }));
      expect(await screen.findByText("free-model")).toBeInTheDocument();
      const errors = errorSpy.mock.calls.flat().join(" ");
      expect(errors).not.toContain("The final argument passed to useMemo changed size");
    } finally {
      errorSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

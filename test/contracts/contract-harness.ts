import { buildPipelineHarness } from "../helpers/pipeline-harness";
import type { App } from "../../src/app";
/** A body factory output suitable for a public JSON request. */
export type RequestBody = Readonly<Record<string, unknown>>;

/** Optional top-level fields for deterministic request fixtures. */
export type RequestBodyOverrides = Readonly<Record<string, unknown>>;

/** The three deterministic public request body factory methods. */
export interface RequestBodyFactories {
  openAiChat(overrides?: RequestBodyOverrides): RequestBody;
  openAiResponses(overrides?: RequestBodyOverrides): RequestBody;
  anthropicMessages(overrides?: RequestBodyOverrides): RequestBody;
}

/** Deterministic request body factories for the three public wire surfaces. */
export const RequestBodyFactories = {
  openAiChat(overrides: RequestBodyOverrides = {}): RequestBody {
    return {
      model: "cartethyia-test-model",
      messages: [{ role: "user", content: "Hello from Cartethyia" }],
      stream: false,
      ...overrides,
    };
  },

  openAiResponses(overrides: RequestBodyOverrides = {}): RequestBody {
    return {
      model: "cartethyia-test-model",
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello from Cartethyia" }] }],
      stream: false,
      ...overrides,
    };
  },

  anthropicMessages(overrides: RequestBodyOverrides = {}): RequestBody {
    return {
      model: "cartethyia-test-model",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hello from Cartethyia" }],
      stream: false,
      ...overrides,
    };
  },
} satisfies RequestBodyFactories;

/**
 * Shared composition-test assembly for the surface contract suites.
 *
 * The suite exercises the real production pipeline end to end — route, parser,
 * canonical boundary, dispatch, and encoder — against the in-process stubs in
 * `test/helpers/pipeline-harness.ts`. `dispatchCount` reports how many times
 * the stub provider adapter was reached, so a suite can assert that a request
 * was rejected before dispatch.
 */
export class ContractHarness {
  readonly requests = RequestBodyFactories;

  private lastDispatchCounter = { count: 0 };

  /** Adapter dispatches observed for the most recently built composition root. */
  get dispatchCount(): number {
    return this.lastDispatchCounter.count;
  }

  /** Builds the production app composition root over the pipeline harness. */
  async buildProductionCompositionRoot(
    options: { rejectCapabilities?: boolean } = {},
  ): Promise<App> {
    const harness = buildPipelineHarness({
      ...(options.rejectCapabilities === undefined
        ? {}
        : { rejectCapabilities: options.rejectCapabilities }),
    });
    this.lastDispatchCounter = harness.dispatchCounter;
    return harness.app;
  }
}

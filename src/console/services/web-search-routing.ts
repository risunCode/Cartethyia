import type { WebSearchRouteKind } from "../../application/contracts";
import { hasWebSearchCapability, normalizeWebSearchPreference, WEB_SEARCH_PREFERENCE_OPTIONS, WEB_SEARCH_ROUTE_LABELS, webSearchPreferenceOrder } from "../../application/web-search-routing";
import type { AccountService } from "./accounts";
import type { ModelService } from "./models";
import type { ProviderService } from "./providers";
import type { ProxyService } from "./proxy";

export interface WebSearchRouteStatus {
  readonly kind: WebSearchRouteKind;
  readonly label: string;
  readonly available: boolean;
  readonly reason: string | null;
}

export interface WebSearchRoutingStatus {
  readonly preference: ReturnType<typeof normalizeWebSearchPreference>;
  readonly order: readonly WebSearchRouteKind[];
  readonly routes: readonly WebSearchRouteStatus[];
  readonly preferences: typeof WEB_SEARCH_PREFERENCE_OPTIONS;
}

const PROVIDER_ROUTE_IDS: Readonly<Record<"codex" | "antigravity" | "exa", string>> = {
  codex: "codex",
  antigravity: "antigravity",
  exa: "exa",
};

export class WebSearchRoutingService {
  constructor(
    private readonly proxies: ProxyService,
    private readonly providers: ProviderService,
    private readonly models: ModelService,
    private readonly accounts: AccountService,
  ) {}

  async get(): Promise<WebSearchRoutingStatus> {
    const [settings, providers] = await Promise.all([this.proxies.getSettings(), this.providers.list()]);
    const states = await Promise.all(providers.map(async (provider) => {
      const [models, accounts] = await Promise.all([this.models.list(provider.id), this.accounts.list(provider.id)]);
      const searchCapable = models.some((model) => model.enabled && hasWebSearchCapability(model.capabilities));
      const configured = provider.credentialKind === "none" || accounts.some((account) => account.active);
      return { id: provider.id, ready: provider.enabled && configured && searchCapable };
    }));
    const readyByProvider = new Map(states.map((state) => [state.id, state.ready]));
    const nativeReady = states.some((state) => state.ready);
    const preference = normalizeWebSearchPreference(settings.webSearchPreference);
    const order = webSearchPreferenceOrder(preference);
    const routes = order.map((kind): WebSearchRouteStatus => {
      const available = kind === "native" ? nativeReady : kind === "passthrough" ? true : readyByProvider.get(PROVIDER_ROUTE_IDS[kind]) === true;
      let reason: string | null = null;
      if (!available) reason = kind === "native" ? "No enabled search-capable model is ready." : "No configured, active, search-capable provider route is ready.";
      return { kind, label: WEB_SEARCH_ROUTE_LABELS[kind], available, reason };
    });
    return { preference, order, routes, preferences: WEB_SEARCH_PREFERENCE_OPTIONS };
  }
}

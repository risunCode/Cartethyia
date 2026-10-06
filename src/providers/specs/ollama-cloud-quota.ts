import type { FetchLike, ProviderQuotaResult } from "../quota/quota-contracts";
import { getJson, record, text } from "../quota/quota-contracts";
import { parseQuotaWindows } from "../quota/quota-window-parser";

async function fetchPlan(fetcher: FetchLike, headers: Record<string, string>): Promise<string> {
  try {
    const response = await fetcher("https://ollama.com/api/me", {
      method: "POST",
      headers: { accept: "application/json", "content-length": "0", ...headers },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return "Ollama Cloud";
    const body: unknown = JSON.parse(await response.text());
    const plan = text(record(body)?.Plan);
    return plan === null
      ? "Ollama Cloud"
      : `${plan.slice(0, 1).toUpperCase()}${plan.slice(1).toLowerCase()}`;
  } catch {
    return "Ollama Cloud";
  }
}

/** Fetches Ollama Cloud usage windows across free and paid plan shapes. */
export async function fetchOllamaQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const headers = { authorization: `Bearer ${credential}` };
  const [usageBody, plan] = await Promise.all([
    getJson("https://ollama.com/api/usage", headers, fetcher),
    fetchPlan(fetcher, headers),
  ]);
  return parseQuotaWindows(
    usageBody,
    [
      {
        kind: "session",
        label: "Session (5h)",
        usedPercentPaths: [["limits", "session", "usage"]],
        valueMultiplier: 100,
      },
      {
        kind: "weekly",
        label: "Weekly (7d)",
        usedPercentPaths: [["limits", "weekly", "usage"]],
        valueMultiplier: 100,
      },
      {
        kind: "monthly",
        label: "Monthly",
        usedPercentPaths: [["limits", "monthly", "usage"]],
        valueMultiplier: 100,
      },
    ],
    { source: "ollama", planFallback: plan },
  );
}

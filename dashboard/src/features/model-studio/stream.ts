export interface StudioUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  source: "provider" | "estimated";
}

export interface ChatContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ChatUsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export function studioUsageFromChatUsage(usage: ChatUsagePayload): StudioUsage {
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
    source: "provider",
  };
}

export async function streamModelStudioChat(
  payload: {
    model: string;
    messages: { role: string; content: string | ChatContentPart[] }[];
    maxTokens: number;
    reasoningEffort?: string;
    reasoningSummary?: string;
  },
  delta: {
    onText: (chunk: string) => void;
    onReasoning: (chunk: string) => void;
    onUsage: (usage: StudioUsage) => void;
    onFirstToken: (ms: number) => void;
  },
  signal: AbortSignal,
): Promise<void> {
  const startTime = performance.now();
  let firstTokenRecorded = false;
  const res = await fetch("/console/api/model-studio/chat", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    let message = `request failed (${res.status})`;
    try {
      const errBody = (await res.json()) as { error?: { message?: string } };
      if (errBody.error?.message) message = errBody.error.message;
    } catch {
      // Keep the generic HTTP failure when the response is not JSON.
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const data = dataLine.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let parsed: { choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>; usage?: ChatUsagePayload };
      try {
        parsed = JSON.parse(data) as typeof parsed;
      } catch {
        continue;
      }
      const choiceDelta = parsed.choices?.[0]?.delta;
      if (choiceDelta?.content || choiceDelta?.reasoning_content) {
        if (!firstTokenRecorded) {
          firstTokenRecorded = true;
          delta.onFirstToken(performance.now() - startTime);
        }
      }
      if (choiceDelta?.content) delta.onText(choiceDelta.content);
      if (choiceDelta?.reasoning_content) delta.onReasoning(choiceDelta.reasoning_content);
      if (parsed.usage) delta.onUsage(studioUsageFromChatUsage(parsed.usage));
    }
  }
}

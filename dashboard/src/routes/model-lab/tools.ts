import { isRecord, readConsoleCsrfCookie } from "../../lib/api";

/** Client-executed playground tools: local utilities plus safe web helpers. */
export const STUDIO_TOOLS = [
  {
    name: "printf",
    description: "Print text back verbatim. Useful for testing live tool calling.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "Text to print" } },
      required: ["text"],
    },
  },
  {
    name: "clock",
    description: "Get the current local date and time.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "web_fetch",
    description: "Fetch and extract readable text from a public HTTP(S) page.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "An absolute HTTP or HTTPS URL" },
        maxChars: { type: "integer", minimum: 1000, maximum: 24000 },
      },
      required: ["url"],
    },
  },
  {
    name: "render_mermaid",
    description: "Convert Mermaid flowchart or sequence syntax to a readable ASCII diagram.",
    parameters: {
      type: "object",
      properties: { code: { type: "string", description: "Mermaid diagram source" } },
      required: ["code"],
    },
  },
] as const;

export const MAX_TOOL_TURNS = 5;

export const TOOL_DEFS = STUDIO_TOOLS.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}));
export const LOCAL_TOOL_DEFS = TOOL_DEFS.filter(({ function: tool }) => tool.name !== "web_fetch");

/** Web fetch is opt-in: a generic prompt must never trigger network access. */
export function webToolsExplicitlyRequested(prompt: string): boolean {
  return /(?:\bweb\s*fetch\b|\bfetch\s+https?:\/\/|\bopen\s+https?:\/\/|\bbuka\s+https?:\/\/)/i.test(
    prompt,
  );
}

export function parseStudioToolArgs(argsText: string): Record<string, unknown> | { error: string } {
  try {
    const parsed: unknown = JSON.parse(argsText || "{}");
    return isRecord(parsed) ? parsed : { error: "arguments must be a JSON object" };
  } catch {
    return { error: "arguments must be valid JSON" };
  }
}

/** Executes one local Studio tool synchronously. */
export function executeStudioTool(name: string, argsText: string): string {
  const args = parseStudioToolArgs(argsText);
  if ("error" in args) return JSON.stringify(args);
  if (name === "printf") {
    const text = args["text"];
    if (typeof text !== "string") return JSON.stringify({ error: "printf requires {text: string}" });
    return JSON.stringify({ output: text });
  }
  if (name === "clock") {
    const now = new Date();
    return JSON.stringify({ iso: now.toISOString(), local: now.toString() });
  }
  if (name === "render_mermaid") {
    const code = args["code"];
    return typeof code === "string"
      ? JSON.stringify({ ascii: mermaidToAscii(code) })
      : JSON.stringify({ error: "render_mermaid requires {code: string}" });
  }
  return JSON.stringify({ error: `unknown tool: ${name}` });
}

export function mermaidToAscii(source: string): string {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("%%"));
  const edges = lines.flatMap((line) => {
    const flow = line.match(/^([A-Za-z0-9_-]+)\s*--+>\s*(?:\|([^|]*)\|\s*)?([A-Za-z0-9_-]+)/);
    if (flow) return [`${flow[1]}${flow[2] ? ` -[${flow[2]}]->` : " -->"} ${flow[3]}`];
    const sequence = line.match(/^([A-Za-z0-9_-]+)\s*[-=]+>>\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    return sequence ? [`${sequence[1]} -> ${sequence[2]}: ${sequence[3]}`] : [];
  });
  return edges.length > 0 ? edges.join("\n") : lines.join("\n");
}

/** Executes local or backend-backed Studio tools. */
export async function executeStudioToolAsync(
  name: string,
  argsText: string,
  signal?: AbortSignal,
  allowWeb = false,
): Promise<string> {
  if (name !== "web_fetch") return executeStudioTool(name, argsText);
  if (!allowWeb) return JSON.stringify({ error: "web fetch requires an explicit web request" });
  const args = parseStudioToolArgs(argsText);
  if ("error" in args) return JSON.stringify(args);
  const endpoint = "/console/api/studio/web-fetch";
  const body = { url: args["url"], maxChars: args["maxChars"] };
  try {
    const csrf = readConsoleCsrfCookie();
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    const payload: unknown = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    return JSON.stringify(response.ok ? payload : { error: payload });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : "web tool request failed" });
  }
}

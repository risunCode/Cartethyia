/**
 * DeepSeek sometimes emits its native tool markup as assistant text when the
 * structured tool channel was dropped in transit. A complete, well-formed block
 * becomes ordinary tool calls; anything incomplete stays text.
 */

const PIPE = "\uFF5C\uFF5C";
const CALLS = new RegExp(`<${PIPE}DSML${PIPE}\\s+calls>([\\s\\S]*?)</${PIPE}DSML${PIPE}\\s+calls>`, "i");
const INVOKE = new RegExp(`<${PIPE}DSML${PIPE}\\s+invoke\\s+name=["']([^"']+)["']>([\\s\\S]*?)</${PIPE}DSML${PIPE}\\s+invoke>`, "gi");
const PARAMETER = new RegExp(`<${PIPE}DSML${PIPE}\\s+parameter\\s+name=["']([^"']+)["'][^>]*>([\\s\\S]*?)</${PIPE}DSML${PIPE}\\s+parameter>`, "gi");
const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;

export interface DsmlToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface DsmlRecovery {
  readonly text: string;
  readonly calls: readonly DsmlToolCall[];
}

export function parseDsmlToolCalls(text: string): DsmlRecovery | undefined {
  if (!text.includes("DSML")) return undefined;
  const block = CALLS.exec(text);
  if (block === null || block[1] === undefined || block.index === undefined) return undefined;
  const calls: DsmlToolCall[] = [];
  for (const invoke of block[1].matchAll(INVOKE)) {
    const name = invoke[1]?.trim() ?? "";
    if (!TOOL_NAME.test(name)) return undefined;
    const args: Record<string, string> = {};
    for (const parameter of (invoke[2] ?? "").matchAll(PARAMETER)) {
      const key = parameter[1]?.trim();
      if (key === undefined || key.length === 0) return undefined;
      args[key] = (parameter[2] ?? "").trim();
    }
    calls.push({
      id: `call_dsml_${calls.length}_${name}`,
      name,
      arguments: JSON.stringify(args),
    });
  }
  if (calls.length === 0) return undefined;
  const visible = `${text.slice(0, block.index)}${text.slice(block.index + block[0].length)}`.trim();
  return { text: visible, calls };
}

import { describe, expect, test } from "bun:test";
import { terminalWebSocket, isTerminalUpgradeRequest } from "../../src/console/terminal-ws";
import type { ServerWebSocket } from "bun";

// ── Mock ServerWebSocket ─────────────────────────────────────────────────
// The terminal-ws module only uses ws.send() and the data field.
// We build a minimal mock that captures sent messages.

interface CapturedMessage {
  type: string;
  data?: string;
  exitCode?: number;
}

function createMockWs(): { ws: ServerWebSocket<unknown>; messages: CapturedMessage[] } {
  const messages: CapturedMessage[] = [];
  const ws = {
    send(msg: string) {
      messages.push(JSON.parse(msg) as CapturedMessage);
    },
    subscribe() {},
    unsubscribe() {},
    publish() {},
    publishToSubscriptions() {},
    readyState: 1,
    remoteAddress: "127.0.0.1",
    data: {} as unknown,
  } as unknown as ServerWebSocket<unknown>;
  return { ws, messages };
}

// Helper: send a command message and collect responses
async function sendCommand(cmd: string): Promise<CapturedMessage[]> {
  const { ws, messages } = createMockWs();
  const handler = terminalWebSocket;
  await (handler.message as (ws: ServerWebSocket<unknown>, message: string | Buffer) => Promise<void>)(ws, JSON.stringify({ type: "command", data: cmd }));
  return messages;
}

describe("isTerminalUpgradeRequest", () => {
  test("returns true for WebSocket upgrade on terminal path", () => {
    const req = new Request("https://example.com/console/api/terminal/ws", {
      headers: { upgrade: "websocket" },
    });
    expect(isTerminalUpgradeRequest(req)).toBe(true);
  });

  test("returns false when upgrade header is missing", () => {
    const req = new Request("https://example.com/console/api/terminal/ws");
    expect(isTerminalUpgradeRequest(req)).toBe(false);
  });

  test("returns false when upgrade header is not websocket", () => {
    const req = new Request("https://example.com/console/api/terminal/ws", {
      headers: { upgrade: "h2c" },
    });
    expect(isTerminalUpgradeRequest(req)).toBe(false);
  });

  test("returns false for wrong path", () => {
    const req = new Request("https://example.com/console/api/other/ws", {
      headers: { upgrade: "websocket" },
    });
    expect(isTerminalUpgradeRequest(req)).toBe(false);
  });

  test("returns false for non-terminal path with websocket upgrade", () => {
    const req = new Request("https://example.com/console/api/streams", {
      headers: { upgrade: "websocket" },
    });
    expect(isTerminalUpgradeRequest(req)).toBe(false);
  });
});

describe("terminalWebSocket — open handler", () => {
  test("sends connected message on open", () => {
    const { ws, messages } = createMockWs();
    (terminalWebSocket.open as (ws: ServerWebSocket<unknown>) => void)(ws);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("connected");
    expect(messages[0]!.data).toContain("Terminal");
  });
});

describe("terminalWebSocket — message handler", () => {
  test("ping message returns pong", async () => {
    const { ws, messages } = createMockWs();
    await (terminalWebSocket.message as (ws: ServerWebSocket<unknown>, message: string | Buffer) => Promise<void>)(ws, JSON.stringify({ type: "ping" }));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("pong");
  });

  test("invalid JSON sends error", async () => {
    const { ws, messages } = createMockWs();
    await (terminalWebSocket.message as (ws: ServerWebSocket<unknown>, message: string | Buffer) => Promise<void>)(ws, "not json{{{");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("error");
    expect(messages[0]!.data).toContain("Invalid message");
  });

  test("empty command produces no output", async () => {
    const messages = await sendCommand("   ");
    // Empty/whitespace command: executeCommand returns early, no messages sent
    expect(messages).toHaveLength(0);
  });

  test("help builtin returns help text", async () => {
    const messages = await sendCommand("help");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("output");
    expect(messages[0]!.data).toContain("Cartethyia Terminal");
    expect(messages[0]!.data).toContain("root shell");
  });

  test("clear builtin returns __CLEAR__ marker", async () => {
    const messages = await sendCommand("clear");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("output");
    expect(messages[0]!.data).toBe("__CLEAR__");
  });

  test("cls builtin also clears (alias)", async () => {
    const messages = await sendCommand("cls");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.data).toBe("__CLEAR__");
  });

  test("blocks rm -rf / pattern", async () => {
    const messages = await sendCommand("rm -rf /");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("error");
    expect(messages[0]!.data).toContain("Blocked");
  });

  test("blocks rm -rf / with trailing space", async () => {
    const messages = await sendCommand("rm -rf / ");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("error");
    expect(messages[0]!.data).toContain("Blocked");
  });

  test.each(["vim", "vi", "nano", "emacs", "less", "more", "man", "tmux", "screen", "top", "htop", "btop", "tig", "lazygit"])(
    "rejects TUI command: %s",
    async (tui) => {
      const messages = await sendCommand(tui);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe("output");
      expect(messages[0]!.data).toContain("interactive TTY");
    }
  );

  test("echo builtin command executes successfully", async () => {
    const messages = await sendCommand("echo hello-world");
    // Should have output + exit
    const outputMsg = messages.find((m) => m.type === "output");
    const exitMsg = messages.find((m) => m.type === "exit");
    expect(outputMsg).toBeDefined();
    expect(outputMsg!.data).toContain("hello-world");
    expect(exitMsg).toBeDefined();
    expect(exitMsg!.exitCode).toBe(0);
  });

  test("pwd builtin command executes", async () => {
    const messages = await sendCommand("pwd");
    const outputMsg = messages.find((m) => m.type === "output");
    expect(outputMsg).toBeDefined();
    expect(outputMsg!.data!.length).toBeGreaterThan(0);
  });

  test("executes multi-word command with arguments", async () => {
    const messages = await sendCommand("echo foo bar baz");
    const outputMsg = messages.find((m) => m.type === "output");
    expect(outputMsg).toBeDefined();
    expect(outputMsg!.data).toContain("foo bar baz");
  });

  test("command failure returns non-zero exit code", async () => {
    const messages = await sendCommand("false");
    const exitMsg = messages.find((m) => m.type === "exit");
    expect(exitMsg).toBeDefined();
    expect(exitMsg!.exitCode).not.toBe(0);
  });

  test("nonexistent command returns error output", async () => {
    const messages = await sendCommand("this-command-does-not-exist-xyz");
    const outputMsg = messages.find((m) => m.type === "output");
    const exitMsg = messages.find((m) => m.type === "exit");
    // sh will print "not found" to stderr and return non-zero exit
    expect(outputMsg).toBeDefined();
    expect(exitMsg).toBeDefined();
    expect(exitMsg!.exitCode).not.toBe(0);
  });

  test("stderr is included in output", async () => {
    const messages = await sendCommand("echo stderr-msg >&2");
    const outputMsg = messages.find((m) => m.type === "output");
    expect(outputMsg).toBeDefined();
    expect(outputMsg!.data).toContain("stderr-msg");
  });

  test("accepts Buffer input as well as string", async () => {
    const { ws, messages } = createMockWs();
    const buf = Buffer.from(JSON.stringify({ type: "ping" }));
    await (terminalWebSocket.message as (ws: ServerWebSocket<unknown>, message: string | Buffer) => Promise<void>)(ws, buf);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("pong");
  });

  test("command with no output returns '(no output)'", async () => {
    const messages = await sendCommand("true");
    const outputMsg = messages.find((m) => m.type === "output");
    expect(outputMsg).toBeDefined();
    expect(outputMsg!.data).toBe("(no output)");
  });
});

describe("terminalWebSocket — close handler", () => {
  test("close handler does not throw", () => {
    const { ws } = createMockWs();
    expect(() => (terminalWebSocket.close as (ws: ServerWebSocket<unknown>) => void)(ws)).not.toThrow();
  });
});

describe("terminalWebSocket — drain handler", () => {
  test("drain handler does not throw", () => {
    const { ws } = createMockWs();
    expect(() => (terminalWebSocket.drain as (ws: ServerWebSocket<unknown>) => void)(ws)).not.toThrow();
  });
});

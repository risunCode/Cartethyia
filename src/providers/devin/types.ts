// Core domain types for DevinRouter

/** A single account entry from account.toml */
export interface PoolAccount {
	id: string;
	email: string;
	/** Session token — may or may not have the "devin-session-token$" prefix */
	token: string;
	plan: string;
	enabled: boolean;
	lastRefresh: number;
	method: string;
}

/** Rotation strategy for account selection */
export type RotationStrategy = "round-robin" | "random";

/** OpenAI-compatible assistant tool call preserved in conversation history. */
export interface ChatToolCall {
	id: string;
	type?: "function";
	function?: {
		name?: string;
		arguments?: string;
	};
}

/** A chat message in the conversation */
export interface ChatMessage {
	role: "user" | "assistant" | "developer" | "tool";
	content: string;
	toolCallId?: string;
	toolCalls?: ChatToolCall[];
	isError?: boolean;
}

/** OpenAI-compatible function tool accepted by DevinRouter. */
export interface ChatTool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: unknown;
		strict?: boolean;
	};
}

/** Model configuration for Devin */
export interface DevinModel {
	id: string;
	name: string;
	contextLength?: number;
	maxTokens?: number;
	baseUrl?: string;
}

/** Streaming chat chunk types yielded by router.stream() */
export type ChatChunk =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool_call"; id: string; name: string; args: string }
	| { type: "usage"; input: number; output: number }
	| { type: "done"; stopReason: string }
	| { type: "error"; error: Error };

/** Options for router.stream() */
export interface StreamOptions {
	messages: ChatMessage[];
	systemPrompt?: string;
	model?: DevinModel;
	conversationId?: string;
	maxTokens?: number;
	temperature?: number;
	stopSequences?: string[];
	tools?: ChatTool[];
	signal?: AbortSignal;
	fetch?: typeof fetch;
	/** Internal hook invoked immediately before an account is used for this request. */
	onAccountSelected?: (account: PoolAccount) => void;
}

/** Options for createDevinRouter() */
export interface DevinRouterOptions {
	poolPath: string;
	watch?: boolean;
	model?: DevinModel;
}

/** Public DevinRouter interface */
export interface DevinRouter {
	pool: {
		next(): PoolAccount;
		disable(accountId: string): void;
		reload(accounts: PoolAccount[]): void;
		readonly activeCount: number;
		readonly size: number;
	};
	stream(options: StreamOptions): AsyncIterable<ChatChunk>;
	close(): void;
}

// streamDevin — protobuf streaming to Codeium Cascade API
// Ported from oh-my-pi-main packages/ai/src/providers/devin.ts
// Adapted for DevinRouter: removes oh-my-pi-specific deps, uses local types.

import { gunzipSync, gzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	DevinAccountLimitError,
	DevinApiError,
	DevinAuthError,
	DevinQuotaError,
	hasDefinitiveQuotaMessage,
	hasTemporaryAccountLimitMessage,
} from "./errors.js";
import {
	ChatMessageRequestType,
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
} from "./proto-gen/exa/api_server_pb/api_server_pb.js";
import { GetUserJwtRequestSchema, GetUserJwtResponseSchema } from "./proto-gen/exa/auth_pb/auth_pb.js";
import {
	CacheControlType,
	type ChatMessagePrompt,
	ChatMessagePromptSchema,
	ChatToolChoiceSchema,
	ChatToolDefinitionSchema,
	PromptCacheOptionsSchema,
} from "./proto-gen/exa/chat_pb/chat_pb.js";
import {
	ChatMessageSource,
	ChatToolCallSchema,
	CompletionConfigurationSchema,
	ConversationalPlannerMode,
	ImageDataSchema,
	MetadataSchema,
	StopReason,
} from "./proto-gen/exa/codeium_common_pb/codeium_common_pb.js";
import type { ChatChunk, ChatMessage, ChatTool, ChatToolCall, DevinModel, StreamOptions } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export const DEVIN_API_URL = "https://server.codeium.com";
const CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const DEVIN_IDE_VERSION = "3.2.23";
const DEVIN_EXTENSION_VERSION = "1.48.2";
const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";
const DEVIN_DEFAULT_STOP_PATTERNS = [
	"<|user|>",
	"<|bot|>",
	"<|context_request|>",
	"<|endoftext|>",
	"<|end_of_turn|>",
];

/** Connect streaming framing: flag byte bit 0x01 = gzip, 0x02 = end-of-stream JSON trailers. */
const CONNECT_COMPRESSED_FLAG = 0x01;
const CONNECT_END_STREAM_FLAG = 0x02;
const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;

// ─── Token Normalization ────────────────────────────────────────────────────

export function normalizeDevinSessionToken(apiKey: string | undefined): string {
	if (!apiKey) return "";
	return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX)
		? apiKey
		: `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

// ─── Auth Metadata ──────────────────────────────────────────────────────────

interface DevinAuthResult {
	userJwt: string;
	baseUrl?: string;
}

export async function fetchDevinAuthMetadata(
	apiKey: string,
	baseUrl: string,
	fetchImpl: typeof fetch,
	signal: AbortSignal | undefined,
): Promise<DevinAuthResult> {
	const request = create(GetUserJwtRequestSchema, {
		metadata: create(MetadataSchema, {
			apiKey,
			ideName: "windsurf",
			ideVersion: DEVIN_IDE_VERSION,
			extensionName: "windsurf",
			extensionVersion: DEVIN_EXTENSION_VERSION,
			locale: "en",
		}),
	});

	const response = await fetchImpl(`${baseUrl}${DEVIN_AUTH_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/proto",
			"connect-protocol-version": "1",
			accept: "*/*",
		},
		body: toBinary(GetUserJwtRequestSchema, request),
		signal,
	});

	const payload = new Uint8Array(await response.arrayBuffer());

	if (!response.ok) {
		const text = new TextDecoder().decode(payload);
		if (response.status === 401 || response.status === 403) {
			throw new DevinAuthError(`Devin auth error ${response.status}: ${text}`, response.status);
		}
		throw new DevinApiError(
			`Devin auth error ${response.status} ${response.statusText}: ${text}`,
			response.status,
		);
	}

	const decoded = decodeDevinUserJwtResponse(payload);
	if (!decoded.userJwt) {
		throw new DevinApiError("Devin auth error: GetUserJwt returned an empty user JWT", 500);
	}

	const customBaseUrl = decoded.customApiServerUrl.trim();
	return {
		userJwt: decoded.userJwt,
		...(customBaseUrl ? { baseUrl: customBaseUrl.replace(/\/+$/, "") } : undefined),
	};
}

function decodeDevinUserJwtResponse(payload: Uint8Array) {
	try {
		return fromBinary(GetUserJwtResponseSchema, payload);
	} catch {
		return fromBinary(GetUserJwtResponseSchema, gunzipSync(payload));
	}
}

// ─── Chat Request Builder ───────────────────────────────────────────────────

interface DevinContext {
	systemPrompt?: string;
	messages: ChatMessage[];
}

export function buildDevinChatRequest(
	model: DevinModel,
	context: DevinContext,
	options: StreamOptions | undefined,
	apiKey: string,
	userJwt: string,
) {
	const cascadeId = options?.conversationId ?? crypto.randomUUID();
	const stopPatterns =
		options?.stopSequences && options.stopSequences.length > 0
			? [...DEVIN_DEFAULT_STOP_PATTERNS, ...options.stopSequences]
			: DEVIN_DEFAULT_STOP_PATTERNS;

	return create(GetChatMessageRequestSchema, {
		metadata: create(MetadataSchema, {
			apiKey,
			userJwt,
			ideName: "windsurf",
			ideVersion: DEVIN_IDE_VERSION,
			extensionName: "windsurf",
			extensionVersion: DEVIN_EXTENSION_VERSION,
			locale: "en",
		}),
		prompt: context.systemPrompt ?? "",
		chatMessagePrompts: buildChatMessagePrompts(context.messages, cascadeId),
		chatModelUid: model.id,
		requestType: ChatMessageRequestType.CASCADE,
		plannerMode: ConversationalPlannerMode.DEFAULT,
		toolChoice: create(ChatToolChoiceSchema, { choice: { case: "optionName", value: "auto" } }),
		systemPromptCacheOptions: create(PromptCacheOptionsSchema, {
			type: CacheControlType.EPHEMERAL,
		}),
		disableParallelToolCalls: true,
		cascadeId,
		executionId: crypto.randomUUID(),
		configuration: create(CompletionConfigurationSchema, {
			numCompletions: 1n,
			maxTokens: BigInt(options?.maxTokens ?? model.maxTokens ?? 64000),
			maxNewlines: 200n,
			temperature: options?.temperature ?? 0.4,
			firstTemperature: options?.temperature ?? 0.4,
			topK: 50n,
			topP: 1,
			stopPatterns,
			fimEotProbThreshold: 1,
		}),
		tools: buildToolDefinitions(options?.tools ?? []),
	});
}

function buildToolDefinitions(tools: ChatTool[]) {
	return tools
		.filter((tool) => tool.type === "function" && tool.function.name.trim().length > 0)
		.map((tool) =>
			create(ChatToolDefinitionSchema, {
				name: tool.function.name,
				description: tool.function.description ?? "",
				jsonSchemaString: JSON.stringify(tool.function.parameters ?? { type: "object", properties: {} }),
				strict: Boolean(tool.function.strict),
				isCustomTool: true,
			}),
		);
}

function buildChatMessagePrompts(messages: ChatMessage[], cascadeId: string): ChatMessagePrompt[] {
	const prompts: ChatMessagePrompt[] = [];

	for (const msg of messages) {
		if (msg.role === "user" || msg.role === "developer") {
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: crypto.randomUUID(),
					source: ChatMessageSource.USER,
					prompt: msg.content,
					images: [],
				}),
			);
		} else if (msg.role === "assistant") {
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: crypto.randomUUID(),
					source: ChatMessageSource.SYSTEM,
					prompt: msg.content,
					toolCalls: buildToolCalls(msg.toolCalls ?? []),
				}),
			);
		} else if (msg.role === "tool") {
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: crypto.randomUUID(),
					source: ChatMessageSource.TOOL,
					prompt: msg.content,
					toolCallId: msg.toolCallId ?? "",
					toolResultIsError: Boolean(msg.isError),
					images: [],
				}),
			);
		}
	}

	return prompts;
}

function buildToolCalls(toolCalls: ChatToolCall[]) {
	return toolCalls.map((toolCall) =>
		create(ChatToolCallSchema, {
			id: toolCall.id,
			name: toolCall.function?.name ?? "",
			argumentsJson: toolCall.function?.arguments ?? "{}",
			isCustomToolCall: true,
		}),
	);
}

// ─── Connect Trailer Error Parser ───────────────────────────────────────────

interface TrailerError {
	message: string;
	code: string;
}

function readConnectTrailerError(text: string): TrailerError | null {
	if (text.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return null;
	const err = (parsed as Record<string, unknown>).error;
	if (!err || typeof err !== "object") return null;
	const code = "code" in err && typeof err.code === "string" ? err.code : "";
	const message = "message" in err && typeof err.message === "string" ? err.message : "";
	if (!code && !message) return null;
	return { message: `Devin stream error${code ? ` ${code}` : ""}: ${message}`, code };
}

// ─── Stream Function ────────────────────────────────────────────────────────

/**
 * Stream a chat completion from the Devin (Codeium Cascade) API.
 *
 * Uses the Connect protocol over HTTP/1.1 with protobuf encoding.
 * Returns an AsyncIterable of ChatChunk events.
 */
export async function* streamDevin(
	model: DevinModel,
	context: DevinContext,
	options: StreamOptions | undefined,
	apiKey: string,
): AsyncGenerator<ChatChunk> {
	const fetchImpl = options?.fetch ?? fetch;
	const baseUrl = (model.baseUrl ?? DEVIN_API_URL).replace(/\/+$/, "");
	const normalizedApiKey = normalizeDevinSessionToken(apiKey);

	// 1. Get user JWT
	const auth = await fetchDevinAuthMetadata(normalizedApiKey, baseUrl, fetchImpl, options?.signal);
	const chatBaseUrl = auth.baseUrl ?? baseUrl;

	// 2. Build protobuf request
	const request = buildDevinChatRequest(model, context, options, normalizedApiKey, auth.userJwt);
	const reqBytes = toBinary(GetChatMessageRequestSchema, request);
	const gz = gzipSync(reqBytes);

	// 3. Wrap in Connect frame (compressed)
	const frame = Buffer.alloc(5 + gz.length);
	frame[0] = CONNECT_COMPRESSED_FLAG;
	frame.writeUInt32BE(gz.length, 1);
	frame.set(gz, 5);

	// 4. POST to GetChatMessage
	const response = await fetchImpl(chatBaseUrl + CHAT_MESSAGE_PATH, {
		method: "POST",
		headers: {
			"content-type": "application/connect+proto",
			"connect-protocol-version": "1",
			"connect-content-encoding": "gzip",
			"accept-encoding": "identity",
			"user-agent": "connect-go/1.18.1 (go1.26.3)",
			"connect-accept-encoding": "gzip",
		},
		body: frame,
		signal: options?.signal,
	});

	if (!response.ok) {
		const text = await response.text();
		const message = `Devin API error ${response.status} ${response.statusText}: ${text}`;
		if (hasTemporaryAccountLimitMessage(text)) {
			throw new DevinAccountLimitError(message, response.status);
		}
		if (hasDefinitiveQuotaMessage(text)) {
			throw new DevinQuotaError(message, response.status);
		}
		if (response.status === 401 || response.status === 403) {
			throw new DevinAuthError(message, response.status);
		}
		throw new DevinApiError(message, response.status);
	}

	if (!response.body) {
		throw new DevinApiError("Devin API error: response body is empty", 500);
	}

	// 5. Parse Connect streaming frames
	const reader = response.body.getReader();
	let pending = Buffer.alloc(0);
	let latestStopReason = StopReason.UNSPECIFIED;

	for (;;) {
		const { done, value } = await reader.read();
		if (value && value.length > 0) {
			pending = Buffer.concat([pending, value]);
		}

		while (pending.length >= 5) {
			const flag = pending[0]!;
			const len = pending.readUInt32BE(1);
			if (len > MAX_CONNECT_FRAME_PAYLOAD) {
				throw new DevinApiError(
					`Devin Connect frame length ${len} exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`,
					500,
				);
			}
			if (pending.length < 5 + len) break;

			const payload = pending.subarray(5, 5 + len);
			pending = pending.subarray(5 + len);

			// End-of-stream trailer (JSON with possible error)
			if (flag & CONNECT_END_STREAM_FLAG) {
				const trailerBytes = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
				const trailerError = readConnectTrailerError(trailerBytes.toString("utf8").trim());
				if (trailerError) {
					if (hasTemporaryAccountLimitMessage(trailerError.message)) {
						throw new DevinAccountLimitError(trailerError.message);
					}
					if (hasDefinitiveQuotaMessage(trailerError.message)) {
						throw new DevinQuotaError(trailerError.message);
					}
					const authCodes = ["permission_denied", "unauthenticated", "permissiondenied"];
					if (authCodes.includes(trailerError.code)) {
						throw new DevinAuthError(trailerError.message, 403);
					}
					throw new DevinApiError(trailerError.message, 500);
				}
				continue;
			}

			// Data frame — decode protobuf
			const raw = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
			const msg = fromBinary(GetChatMessageResponseSchema, raw);

			if (msg.deltaThinking) {
				yield { type: "thinking", text: msg.deltaThinking };
			}

			if (msg.deltaText) {
				yield { type: "text", text: msg.deltaText };
			}

			if (msg.deltaToolCalls.length > 0) {
				for (const tc of msg.deltaToolCalls) {
					if (tc.name.trim().length === 0) {
						const details = tc.invalidJsonErr || tc.invalidJsonStr || "Devin returned a tool call without a function name";
						yield { type: "error", error: new Error(`Invalid Devin tool call: ${details}`) };
						continue;
					}
					yield {
						type: "tool_call",
						id: tc.id,
						name: tc.name,
						args: tc.argumentsJson,
					};
				}
			}

			if (msg.stopReason !== StopReason.UNSPECIFIED) {
				latestStopReason = msg.stopReason;
			}

			if (msg.usage) {
				yield {
					type: "usage",
					input: Number(msg.usage.inputTokens),
					output: Number(msg.usage.outputTokens),
				};
			}
		}

		if (done) break;
	}

	yield {
		type: "done",
		stopReason: latestStopReason === StopReason.MAX_TOKENS ? "length" : "stop",
	};
}

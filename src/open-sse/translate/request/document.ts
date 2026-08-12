import type { ClientProfile } from "../detection";
import type { ImageReference, NormalizedMessage, NormalizedTool, ProxyRequest, ReasoningConfig, RequestLimits, Surface, TranslationDiagnostic } from "../../../application/contracts";

export type FieldDispositionAction = "preserved" | "adapted" | "unsupported" | "dropped-with-diagnostic";

export interface FieldDisposition {
  readonly path: string;
  readonly action: FieldDispositionAction;
  readonly reason: string;
  readonly targetPath?: string;
}

export interface ReasoningIntent {
  readonly mode: ProxyRequest["reasoning"];
  readonly config?: ReasoningConfig;
}

export interface ResponseControls {
  readonly format: ProxyRequest["responseFormat"];
  readonly maxOutputTokens: number | null;
  readonly parallelToolCalls?: boolean;
}

export interface ConversationState {
  readonly instructions?: readonly NormalizedMessage[];
  readonly previousResponseId?: string;
  readonly store?: boolean;
  readonly include?: readonly string[];
  readonly cacheKey?: string;
  readonly contextManagement?: ProxyRequest["contextManagement"];
}

export interface RequestMetadata {
  readonly userId?: string;
  readonly client?: ClientProfile;
  readonly translationDiagnostics?: readonly TranslationDiagnostic[];
}

export interface SourceWireMetadata {
  readonly surface: Surface;
  readonly stream: boolean;
  readonly limits: RequestLimits;
  readonly hasWirePayload: boolean;
}

export interface RequestDocument {
  readonly model: string;
  readonly messages: readonly NormalizedMessage[];
  readonly tools: readonly NormalizedTool[];
  readonly reasoning: ReasoningIntent;
  readonly response: ResponseControls;
  readonly conversation: ConversationState;
  readonly media: readonly ImageReference[];
  readonly metadata: RequestMetadata;
  readonly source: SourceWireMetadata;
  /** Bounded, explicitly selected extensions; raw wire payload is never copied here. */
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly dispositions: readonly FieldDisposition[];
}

export interface RequestDocumentOptions {
  readonly client?: ClientProfile;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly translationDiagnostics?: readonly TranslationDiagnostic[];
}

export function toRequestDocument(request: ProxyRequest, options: RequestDocumentOptions = {}): RequestDocument {
  const dispositions: FieldDisposition[] = [
    disposition("model", "preserved", "canonical model identifier"),
    disposition("messages", "preserved", "canonical conversation blocks"),
    disposition("tools", "preserved", "canonical tool definitions"),
    disposition("reasoning", "preserved", "canonical reasoning intent"),
    disposition("images", "preserved", "canonical media references"),
  ];
  if (request.wirePayload !== undefined) dispositions.push(disposition("wirePayload", "preserved", "owned by same-surface preservation policy"));
  return {
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    reasoning: { mode: request.reasoning, ...(request.reasoningConfig === undefined ? {} : { config: request.reasoningConfig }) },
    response: { format: request.responseFormat, maxOutputTokens: request.maxOutputTokens },
    conversation: {
      ...(request.include === undefined ? {} : { include: request.include }),
      ...(request.contextManagement === undefined ? {} : { contextManagement: request.contextManagement }),
      ...(request.cacheKey === undefined ? {} : { cacheKey: request.cacheKey }),
    },
    media: request.images,
    metadata: {
      ...(request.metadataUserId === undefined ? {} : { userId: request.metadataUserId }),
      ...(options.client === undefined ? {} : { client: options.client }),
      ...(options.translationDiagnostics === undefined ? {} : { translationDiagnostics: options.translationDiagnostics }),
    },
    source: {
      surface: request.sourceSurface,
      stream: request.stream,
      limits: request.limits,
      hasWirePayload: request.wirePayload !== undefined,
    },
    extensions: options.extensions ?? {},
    dispositions,
  };
}

export function withFieldDisposition(document: RequestDocument, field: FieldDisposition): RequestDocument {
  return { ...document, dispositions: [...document.dispositions, field] };
}

function disposition(path: string, action: FieldDispositionAction, reason: string, targetPath?: string): FieldDisposition {
  return { path, action, reason, ...(targetPath === undefined ? {} : { targetPath }) };
}

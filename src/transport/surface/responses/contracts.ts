import type { AssistantItemPhase } from "../../canonical-model";

export interface ResponsesComputerAction {
  type:
    | "click"
    | "double_click"
    | "drag"
    | "keypress"
    | "move"
    | "screenshot"
    | "scroll"
    | "type"
    | "wait";
  [field: string]: unknown;
}

/** A typed Responses input item accepted by the adapter. */
export type ResponsesInputItem = Readonly<Record<string, unknown>>;

/** A request body on the OpenAI Responses surface. */
export type ResponsesRequestBody = Readonly<Record<string, unknown>>;

/** Metadata retained as a scoped extension for each ordered Responses item. */
export interface ResponsesItemMetadata {
  type: string;
  id?: string;
  call_id?: string;
  role?: string;
  content_types?: readonly string[];
  /** Assistant item phase (`commentary` / `final_answer`), preserved for replay. */
  phase?: AssistantItemPhase;
  /** `computer_call` safety checks, preserved verbatim for the next turn. */
  pending_safety_checks?: unknown;
}

/** Context used when encoding canonical events for a Responses client. */
export interface ResponsesEncodingContext {
  response_id?: string;
  model?: string;
  created_at?: number;
}

/** One structured event emitted by the Responses stream encoder. */
export interface ResponsesWireEvent {
  type: string;
  sequence_number: number;
  [field: string]: unknown;
}

/** Stable typed failure for encrypted-reasoning policy violations. */

import { GatewayError } from "../../gateway-error";

/** Typed failures for the OpenAI Responses surface. */
export class ResponsesReasoningError extends GatewayError {
  readonly field: "include" | "store" | "reasoning.encrypted_content";

  constructor(field: "include" | "store" | "reasoning.encrypted_content", message: string) {
    super("capability_unsupported", 400, message, { field });
    this.name = "ResponsesReasoningError";
    this.field = field;
  }
}

/** Stable typed failure for malformed canonical sequence numbers. */
export class ResponsesSequenceError extends GatewayError {
  constructor(message: string) {
    super("invalid_sequence", 500, message);
    this.name = "ResponsesSequenceError";
  }
}

/** Stable typed failure for invalid lifecycle transitions. */
export class ResponsesLifecycleError extends GatewayError {
  constructor(message: string) {
    super("invalid_lifecycle", 500, message);
    this.name = "ResponsesLifecycleError";
  }
}

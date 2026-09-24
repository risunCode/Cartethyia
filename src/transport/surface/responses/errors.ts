/** Typed failures for the OpenAI Responses surface. */

export class ResponsesReasoningError extends Error {
  readonly code = "capability_unsupported" as const;
  readonly field: "include" | "store" | "reasoning.encrypted_content";

  constructor(field: "include" | "store" | "reasoning.encrypted_content", message: string) {
    super(message);
    this.name = "ResponsesReasoningError";
    this.field = field;
  }
}

/** Stable typed failure for malformed canonical sequence numbers. */
export class ResponsesSequenceError extends Error {
  readonly code = "invalid_sequence" as const;

  constructor(message: string) {
    super(message);
    this.name = "ResponsesSequenceError";
  }
}

/** Stable typed failure for invalid lifecycle transitions. */
export class ResponsesLifecycleError extends Error {
  readonly code = "invalid_lifecycle" as const;

  constructor(message: string) {
    super(message);
    this.name = "ResponsesLifecycleError";
  }
}

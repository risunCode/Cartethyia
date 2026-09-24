/** Typed failure for the Anthropic Messages surface. */

export class MessagesLedgerError extends Error {
  readonly code = "tool_ledger_mismatch" as const;

  constructor(message: string) {
    super(message);
    this.name = "MessagesLedgerError";
  }
}

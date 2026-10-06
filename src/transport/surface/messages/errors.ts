/** Typed failure for the Anthropic Messages surface. */
import { GatewayError } from "../../../protocol/gateway-error";

export class MessagesLedgerError extends GatewayError {
  constructor(message: string) {
    super("invalid_request", 400, message, {
      surface: "messages",
      reason: "tool_ledger_mismatch",
    });
    this.name = "MessagesLedgerError";
  }
}

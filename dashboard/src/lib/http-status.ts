/**
 * HTTP reason phrases for the statuses the gateway can return.
 *
 * The Requests filter buttons and the status cell previously hardcoded
 * `"200 OK"` and `"500 ERR"` as literals, and only `200` ever received a
 * reason phrase — every other code rendered as a bare number (`404`, `503`),
 * so the label told an operator nothing they could not already read off the
 * digits, and the two literals could drift from the codes the backend emits.
 *
 * The phrases are the standard ones (`node:http`'s `STATUS_CODES` agrees for
 * every code below), kept as a local table rather than imported from
 * `node:http` because this is browser code. `499` is not in the standard and
 * has no registered phrase; it is named here because the gateway emits it for
 * a client abort and an operator needs to recognize it as "the client left",
 * not as a server defect.
 *
 * Codes the gateway cannot currently return are deliberately absent: an
 * unknown code falls back to the bare number rather than inventing a phrase.
 */
const REASON_PHRASES: Readonly<Record<number, string>> = {
  200: "OK",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  499: "Client Closed Request",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** `200` -> `"200 OK"`; an unrecognized code returns just its digits. */
export function httpStatusLabel(status: number): string {
  const reason = REASON_PHRASES[status];
  return reason === undefined ? String(status) : `${status} ${reason}`;
}

/** Severity tone for a status: green success, red failure, amber in-between. */
export type HttpStatusTone = "ok" | "err" | "warn";

/**
 * Tone is a property of the code, not of a hardcoded status list, so a status
 * the gateway starts returning renders correctly without a CSS edit. `499` is
 * `warn`, not `err`: the client left, which is not a server defect.
 */
export function httpStatusTone(status: number): HttpStatusTone {
  if (status === 200) return "ok";
  if (status === 499) return "warn";
  if (status >= 400) return "err";
  return "warn";
}

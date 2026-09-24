import type { CanonicalEvent, CanonicalRequest } from "../../canonical-model";
import { type SurfaceAdapter, type SurfaceOutput } from "../adapters";
import { isRecord } from "../../../protocol/primitives";
import { canonicalToResponsesPayload } from "../../../protocol/request/responses";
import type { ResponsesEncodingContext, ResponsesRequestBody, ResponsesWireEvent } from "./contracts";
import { hasOwn, parseResponsesRequest, unwrapBody } from "./parse";
import { encodeResponsesEvents, encodeResponsesWireEvents } from "./encode";

/** The OpenAI Responses public surface adapter. */
export class ResponsesAdapter implements SurfaceAdapter {
  readonly surface = "responses" as const;

  /** Check only top-level Responses shape markers, never arbitrary prompt text. */
  matchesBodyShape(body: unknown): boolean {
    try {
      const candidate = unwrapBody(body);
      if (!isRecord(candidate)) return false;
      return (
        Array.isArray(candidate["input"]) ||
        typeof candidate["instructions"] === "string" ||
        hasOwn(candidate, "previous_response_id") ||
        hasOwn(candidate, "conversation")
      );
    } catch {
      return false;
    }
  }

  /** Parse a request body or registry SurfaceInput into canonical form. */
  parse(input: unknown, _detection?: unknown): CanonicalRequest {
    return parseResponsesRequest(input);
  }

  /** Encode events into ordered public Responses lifecycle events. */
  encode(
    events: Iterable<CanonicalEvent>,
    context: ResponsesEncodingContext = {},
  ): ResponsesWireEvent[] {
    return encodeResponsesWireEvents(events, context);
  }

  /** Encode sync events into public JSON or SSE bytes. */
  encodeOutput(
    events: Iterable<CanonicalEvent>,
    context: ResponsesEncodingContext = {},
  ): SurfaceOutput {
    return encodeResponsesEvents(events, context);
  }

  /** Reconstruct the item-based request representation for a next turn. */
  encodeRequest(request: CanonicalRequest): ResponsesRequestBody {
    if (request.source_surface !== "responses")
      throw new Error("Responses encoder requires a Responses canonical request");
    return canonicalToResponsesPayload(request) as ResponsesRequestBody;
  }
}

/** Shared singleton for registries that prefer an adapter instance. */
export const responsesAdapter = new ResponsesAdapter();


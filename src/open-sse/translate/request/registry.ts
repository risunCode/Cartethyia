import type { ProviderCaps, Surface } from "../../../application/contracts";
import type { NormalizeResult } from "../../../application/protocols";
import type { ClientFormat, ClientProfile } from "../detection";
import type { RequestDocument } from "./document";

export interface RequestCodecContext {
  readonly source: ClientFormat;
  readonly target: Surface;
  readonly client: ClientProfile;
  readonly providerId: string;
  readonly model: string;
  readonly capabilities: ProviderCaps;
  readonly signal: AbortSignal;
}

export interface RequestNormalizer {
  readonly source: ClientFormat;
  normalize(input: unknown, context: RequestCodecContext): NormalizeResult;
}

export interface RequestEncoder {
  readonly target: Surface;
  encode(document: RequestDocument, context: RequestCodecContext): Record<string, unknown>;
}

export interface RequestCodec extends RequestNormalizer, RequestEncoder {
  readonly target: Surface;
}

export type RequestRoute =
  | { readonly kind: "direct"; readonly codec: RequestCodec }
  | { readonly kind: "canonical"; readonly normalizer: RequestNormalizer; readonly encoder: RequestEncoder }
  | null;

export class RequestCodecRegistry {
  readonly #codecs = new Map<string, RequestCodec>();
  readonly #normalizers = new Map<ClientFormat, RequestNormalizer>();
  readonly #encoders = new Map<Surface, RequestEncoder>();

  registerCodec(codec: RequestCodec): void {
    const key = routeKey(codec.source, codec.target);
    if (this.#codecs.has(key)) throw new Error(`request codec already registered: ${key}`);
    this.#codecs.set(key, codec);
  }

  registerNormalizer(normalizer: RequestNormalizer): void {
    if (this.#normalizers.has(normalizer.source)) throw new Error(`request normalizer already registered: ${normalizer.source}`);
    this.#normalizers.set(normalizer.source, normalizer);
  }

  registerEncoder(encoder: RequestEncoder): void {
    if (this.#encoders.has(encoder.target)) throw new Error(`request encoder already registered: ${encoder.target}`);
    this.#encoders.set(encoder.target, encoder);
  }

  lookupCodec(source: ClientFormat, target: Surface): RequestCodec | undefined {
    return this.#codecs.get(routeKey(source, target));
  }

  lookupNormalizer(source: ClientFormat): RequestNormalizer | undefined {
    return this.#normalizers.get(source);
  }

  lookupEncoder(target: Surface): RequestEncoder | undefined {
    return this.#encoders.get(target);
  }

  resolve(source: ClientFormat, target: Surface): RequestRoute {
    const direct = this.lookupCodec(source, target);
    if (direct !== undefined) return { kind: "direct", codec: direct };
    const normalizer = this.lookupNormalizer(source);
    const encoder = this.lookupEncoder(target);
    if (normalizer !== undefined && encoder !== undefined) return { kind: "canonical", normalizer, encoder };
    return null;
  }
}

export const requestCodecRegistry = new RequestCodecRegistry();

export function registerRequestCodec(codec: RequestCodec): void {
  requestCodecRegistry.registerCodec(codec);
}

export function registerRequestNormalizer(normalizer: RequestNormalizer): void {
  requestCodecRegistry.registerNormalizer(normalizer);
}

export function registerRequestEncoder(encoder: RequestEncoder): void {
  requestCodecRegistry.registerEncoder(encoder);
}

export function resolveRequestRoute(source: ClientFormat, target: Surface): RequestRoute {
  return requestCodecRegistry.resolve(source, target);
}

function routeKey(source: ClientFormat, target: Surface): string {
  return `${source}->${target}`;
}

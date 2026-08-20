package router

import (
	"context"
	"encoding/json"
	"fmt"

	contracts "github.com/cartethyia/daemon/internal/protocol"
	transforms "github.com/cartethyia/daemon/internal/protocol/codec"
)

// canonicalResponseProjection decodes a provider response through the
// registered ResponseDecoder for the provider target surface and re-encodes
// it through the registered ResponseEncoder for the inbound client surface.
// Same-surface responses are already in the requesting contract and remain a
// native passthrough; cross-surface responses must have both codecs and never
// fall back to the provider's raw body.
func canonicalResponseProjection(req contracts.Request, target contracts.Surface, response *contracts.Response, registry *transforms.Registry) (*contracts.Response, error) {
	if response == nil {
		return nil, fmt.Errorf("response projection: response is nil")
	}
	if req.Stream {
		return response, nil
	}
	if !req.Protocol.IsValid() {
		return nil, fmt.Errorf("response projection: source surface %q is unsupported", req.Protocol)
	}
	if target == "" {
		target = req.Protocol
	}
	if !target.IsValid() {
		return nil, fmt.Errorf("response projection: target surface %q is unsupported", target)
	}
	if target == req.Protocol {
		return response, nil
	}
	if registry == nil {
		return nil, fmt.Errorf("response projection: codec registry is unavailable for %s to %s", target, req.Protocol)
	}
	decoder, ok := registry.LookupResponseDecoder(target)
	if !ok || decoder == nil {
		return nil, fmt.Errorf("response projection: decoder is unavailable for target surface %s", target)
	}
	encoder, ok := registry.LookupResponse(req.Protocol)
	if !ok || encoder == nil {
		return nil, fmt.Errorf("response projection: encoder is unavailable for source surface %s", req.Protocol)
	}
	normalized, terr := decoder.Decode(context.Background(), response.Body, req.Model)
	if terr != nil || normalized == nil {
		if terr == nil {
			return nil, fmt.Errorf("response projection: target decoder returned no response")
		}
		return nil, fmt.Errorf("response projection: target decoder failed: %s", terr.Code)
	}
	payload, terr := encoder.Encode(context.Background(), normalized)
	if terr != nil || payload == nil {
		if terr == nil {
			return nil, fmt.Errorf("response projection: source encoder returned no response")
		}
		return nil, fmt.Errorf("response projection: source encoder failed: %s", terr.Code)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("response projection: encoded response is not JSON: %w", err)
	}
	out := *response
	out.Body = body
	if out.Headers == nil {
		out.Headers = make(map[string][]string)
	}
	out.Headers.Set("Content-Type", "application/json")
	return &out, nil
}

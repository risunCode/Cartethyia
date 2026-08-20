package router

import (
	"context"

	contracts "github.com/cartethyia/daemon/internal/protocol"
)

type compatibilityDecisionContextKey struct{}

// WithCompatibilityDecision carries the immutable protocol decision through
// the request attempt context without coupling transports to catalog plans.
func WithCompatibilityDecision(ctx context.Context, decision contracts.CompatibilityDecision) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, compatibilityDecisionContextKey{}, decision)
}

// CompatibilityDecisionFromContext returns the decision attached to ctx.
func CompatibilityDecisionFromContext(ctx context.Context) (contracts.CompatibilityDecision, bool) {
	if ctx == nil {
		return contracts.CompatibilityDecision{}, false
	}
	decision, ok := ctx.Value(compatibilityDecisionContextKey{}).(contracts.CompatibilityDecision)
	return decision, ok
}

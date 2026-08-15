package api

import (
	"context"

	domaincontracts "github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	base "github.com/cartethyia/daemon/internal/server/apicontracts"
)

const (
	MaxRequestIDBytes = base.MaxRequestIDBytes
	MaxTraceIDBytes   = base.MaxTraceIDBytes
	MaxOriginBytes    = base.MaxOriginBytes
	MaxDisplayBytes   = base.MaxDisplayBytes
	MaxBodyBytes      = base.MaxBodyBytes
)

type RequestMetadata = base.RequestMetadata
type Stream = base.Stream
type StreamReader = base.StreamReader
type ProxyService = base.ProxyService
type ModelCatalog = base.ModelCatalog

func ValidateMetadataValue(name, value string, max int) error {
	return base.ValidateMetadataValue(name, value, max)
}
func ValidateRequestID(name, value string) error   { return base.ValidateRequestID(name, value) }
func AccountDisplay(email, name, id string) string { return base.AccountDisplay(email, name, id) }
func ProxyDisplay(name, id string) string          { return base.ProxyDisplay(name, id) }
func DispatchContext(ctx context.Context, proxy ProxyService, req *domaincontracts.Request) (Stream, error) {
	return base.DispatchContext(ctx, proxy, req)
}

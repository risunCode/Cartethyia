package api

import (
	protocolcontracts "github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	base "github.com/cartethyia/daemon/internal/server/apierrors"
	"net/http"
)

type Code = base.Code
type Error = base.Error
type Response = base.Response

const (
	CodeInvalidRequest   = base.CodeInvalidRequest
	CodeMethodNotAllowed = base.CodeMethodNotAllowed
	CodeNotFound         = base.CodeNotFound
	CodeNotImplemented   = base.CodeNotImplemented
	CodePayloadTooLarge  = base.CodePayloadTooLarge
	CodeUnsupportedMedia = base.CodeUnsupportedMedia
	CodeAuthMissing      = base.CodeAuthMissing
	CodeUpstream         = base.CodeUpstream
	CodeInternal         = base.CodeInternal
	Kind                 = base.Kind
)

func FromRouteError(err *protocolcontracts.RouteError) (int, Response) {
	return base.FromRouteError(err)
}
func Write(w http.ResponseWriter, status int, code Code, message string) {
	base.Write(w, status, code, message)
}
func WriteError(w http.ResponseWriter, err error)          { base.WriteError(w, err) }
func MethodNotAllowed(w http.ResponseWriter, allow string) { base.MethodNotAllowed(w, allow) }
func NotFound(w http.ResponseWriter, message string)       { base.NotFound(w, message) }
func NotImplemented(w http.ResponseWriter, module string)  { base.NotImplemented(w, module) }

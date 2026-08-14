// Package compression owns the token-saving boundary for the proxy path.
//
// It defines composable, dependency-free primitives for local token saving:
//
//   - RTK-style local smart filtering of oversized tool results ("token saver"),
//     applied synchronously and fail-open so the proxy can always proceed.
//
// Every entry point returns a result that records whether compression was
// attempted, the reason it was skipped when it was not, and the byte/block
// deltas when it was. There is no hidden "compressed" path: a disabled or
// misconfigured pipeline always reports a reason and an unchanged request.
package compression

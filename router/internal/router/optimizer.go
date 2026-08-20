package router

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
)

// Orchestrator runs the local token-saving pipeline with an optional cache.
type Orchestrator struct {
	Pipeline  *Pipeline
	Cache     Cache
	TokenOpts PipelineOptions
}

// NewOrchestrator returns an Orchestrator wired to the default token-saver
// pipeline and a no-op cache. Callers can replace either component.
func NewOrchestrator() *Orchestrator {
	return &Orchestrator{
		Pipeline: NewPipeline(),
		Cache:    NoopCache{},
		TokenOpts: PipelineOptions{
			Enabled:       true,
			Quality:       QualityBalanced,
			SmartTruncate: new(true),
		},
	}
}

// CacheKey produces a deterministic key for in. The hash covers model and
// every block's text so two requests with semantically identical content share
// the cache entry. Headers and stream flags are intentionally ignored because
// they are not part of the compression contract.
func CacheKey(in Request) string {
	h := sha256.New()
	h.Write([]byte(in.Model))
	h.Write([]byte{0})
	for _, m := range in.Messages {
		h.Write([]byte(m.Role))
		h.Write([]byte{0})
		// sort blocks by their ToolCallID so input order does not perturb the key
		idx := make([]int, len(m.Content))
		for i := range m.Content {
			idx[i] = i
		}
		sort.SliceStable(idx, func(i, j int) bool {
			return m.Content[idx[i]].ToolCallID < m.Content[idx[j]].ToolCallID
		})
		for _, i := range idx {
			block := m.Content[i]
			h.Write([]byte(string(block.Kind)))
			h.Write([]byte{0})
			h.Write([]byte(block.Text))
			h.Write([]byte{0})
			h.Write([]byte(block.ToolName))
			h.Write([]byte{0})
			h.Write([]byte(block.ToolCallID))
			h.Write([]byte{0})
			if block.ToolResultIsErr {
				h.Write([]byte{1})
			} else {
				h.Write([]byte{0})
			}
			if block.IsUserAuthored {
				h.Write([]byte{1})
			} else {
				h.Write([]byte{0})
			}
		}
		h.Write([]byte{0xff})
	}
	return hex.EncodeToString(h.Sum(nil))
}

// cacheKeyWithOptions includes every option that can change the transformed
// request. A shared cache must not return a balanced result for an extreme (or
// disabled/emergency) invocation.
func cacheKeyWithOptions(in Request, opts PipelineOptions) string {
	h := sha256.New()
	h.Write([]byte(CacheKey(in)))
	h.Write([]byte{0})
	h.Write([]byte(opts.Quality))
	h.Write([]byte{0})
	if opts.Enabled {
		h.Write([]byte("enabled"))
	} else {
		h.Write([]byte("disabled"))
	}
	h.Write([]byte{0})
	if opts.Emergency {
		h.Write([]byte("emergency"))
	} else {
		h.Write([]byte("ordinary"))
	}
	h.Write([]byte{0})
	smart := true
	if opts.SmartTruncate != nil {
		smart = *opts.SmartTruncate
	}
	if smart {
		h.Write([]byte("smart"))
	} else {
		h.Write([]byte("generic"))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Result captures the end-to-end report from Run. Each stage's Summary is
// retained so callers can render per-stage log lines without re-running.
type Result struct {
	Request      Request
	TokenSummary Summary
	CacheHit     bool
}

// Run executes the configured token-saving pipeline. Order is:
//
//  1. Cache lookup: a hit returns the cached outcome verbatim with CacheHit=true.
//  2. Token saver: local, synchronous, fail-open.
//  3. Cache store: best-effort; a Set error is logged via the summary reason
//     but never fails the request.
//
// Any stage that reports ReasonNoShrink or otherwise fails to shrink still
// returns the request — compression is always fail-open.
func (o *Orchestrator) Run(ctx context.Context, in Request) Result {
	if o.Pipeline == nil {
		o.Pipeline = NewPipeline()
	}
	if o.Cache == nil {
		o.Cache = NoopCache{}
	}

	key := cacheKeyWithOptions(in, o.TokenOpts)

	if cached, ok, err := o.Cache.Get(key); ok && err == nil {
		cached.Summary.Reason = ReasonCacheMiss // mark that this came from cache
		return Result{
			Request:      cached.Request,
			TokenSummary: cached.Summary,
			CacheHit:     true,
		}
	}

	tok := ApplyTokenSaver(in, o.Pipeline, o.TokenOpts)

	// Best-effort cache write. Store the token-saver outcome so the next
	// identical request can skip the local stage as well.
	if err := o.Cache.Set(key, Outcome{Request: tok.Request, Summary: tok.Summary}); err != nil {
		if tok.Summary.Attempted {
			tok.Summary.Reason = ReasonCacheError
		}
	}

	return Result{
		Request:      tok.Request,
		TokenSummary: tok.Summary,
	}
}

// ApplyTokenSaver is the local-only stage exposed for callers that want to
// reuse the smart-filter pipeline without the cache.
// It is fail-open: every skip path returns the request unchanged with an
// explicit Reason.
func ApplyTokenSaver(in Request, pipeline *Pipeline, opts PipelineOptions) Outcome {
	if pipeline == nil {
		pipeline = NewPipeline()
	}
	if !opts.Enabled && !opts.Emergency {
		return Skip(in, ReasonDisabled)
	}
	if opts.Emergency && len(in.Messages) < EmergencyMessageThreshold {
		return Skip(in, ReasonEmpty)
	}
	if len(in.Messages) == 0 {
		return Skip(in, ReasonEmpty)
	}

	smart := true
	if opts.SmartTruncate != nil {
		smart = *opts.SmartTruncate
	}

	limits := limitsFor(opts.Quality)
	keepLast := limits.keepLastTurn * 2
	cloned := in.Clone()

	blocks := 0
	before, after := 0, 0
	filterName := ""
	bounded := len(cloned.Messages) - keepLast
	if bounded < 0 {
		bounded = 0
	}
	for mi := range bounded {
		msg := &cloned.Messages[mi]
		for bi := range msg.Content {
			blk := &msg.Content[bi]
			if blk.Kind != BlockToolResult || blk.Text == "" {
				continue
			}
			if len(blk.Text) < filterThreshold {
				continue
			}
			out, changed, name := pipeline.ApplyTransform(blk.Text, limits.maxChars, smart)
			if !changed {
				continue
			}
			before += len(blk.Text)
			after += len(out)
			blk.Text = out
			blocks++
			filterName = name
		}
	}

	if blocks == 0 {
		return Skip(in, ReasonNoShrink)
	}
	return Compressed(cloned, before, after, blocks, filterName)
}

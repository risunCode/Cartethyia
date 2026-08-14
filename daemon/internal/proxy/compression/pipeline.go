package compression

// Transform is the contract an RTK-compatible smart filter must satisfy. It
// receives the original text and the byte budget, and returns the transformed
// text together with a non-empty filter name when the transform was applied.
//
// A transform that decides it has nothing to do MUST return the input text
// unchanged and an empty name. Returning the same length but different content
// is permitted; the pipeline treats it as "lossless" only when the transform
// explicitly reports Lossless=true via LossyFilter.
type Transform interface {
	Name() string
	Apply(text string, maxChars int) (string, bool)
}

// LossyFilter is an optional capability a Transform may implement to declare
// that its output preserves the entire input verbatim (e.g. dedup-log, which
// only collapses adjacent duplicate lines). Lossless transforms are preferred
// when the input already fits the budget.
type LossyFilter interface {
	Lossless() bool
}

// Pipeline is the ordered list of transforms tried in ApplyTransform. The
// order is significant: when AutoDetect picks a specific filter, that filter
// is moved to the front of the list so the first match wins. The pipeline is
// safe to mutate via WithTransforms; it is not safe to share mutating state
// between goroutines.
type Pipeline struct {
	transforms []Transform
	generic    Transform
}

// NewPipeline returns a Pipeline populated with the full default RTK
// transform set. Callers can override with WithTransforms to plug in custom
// formats without editing this file.
func NewPipeline() *Pipeline {
	return &Pipeline{
		transforms: []Transform{
			gitDiffFilter{},
			gitStatusFilter{},
			treeFilter{},
			readNumberedFilter{},
			grepFilter{},
			dedupLogFilter{},
		},
		generic: genericFilter{},
	}
}

// WithTransforms replaces the transform list, preserving the previous generic
// fallback. A nil t is treated as "no change".
func (p *Pipeline) WithTransforms(t []Transform) *Pipeline {
	if p == nil {
		return NewPipeline().WithTransforms(t)
	}
	if t != nil {
		cp := make([]Transform, len(t))
		copy(cp, t)
		p.transforms = cp
	}
	return p
}

// WithGeneric replaces the generic fallback transform. A nil t restores the
// default generic head/tail truncator.
func (p *Pipeline) WithGeneric(t Transform) *Pipeline {
	if p == nil {
		return NewPipeline().WithGeneric(t)
	}
	if t == nil {
		p.generic = genericFilter{}
	} else {
		p.generic = t
	}
	return p
}

// ApplyTransform runs the smart-filter pipeline against text. The decision
// tree mirrors smartTruncate in src.old/open-sse/rtk/index.ts:
//
//   - inputs shorter than the budget: returned verbatim, no filter name
//   - smart mode: try each detector, keep the first that produces a shorter result
//   - otherwise: fall back to the generic truncator
//
// The returned bool is true when a transform actually shortened the text.
func (p *Pipeline) ApplyTransform(text string, maxChars int, smart bool) (string, bool, string) {
	if p == nil {
		return text, false, ""
	}
	if len(text) <= maxChars {
		return text, false, ""
	}
	if !smart {
		out, _ := p.generic.Apply(text, maxChars)
		return out, len(out) < len(text), p.generic.Name()
	}
	for _, t := range p.transforms {
		out, ok := t.Apply(text, maxChars)
		if !ok {
			continue
		}
		if len(out) >= len(text) {
			continue
		}
		return out, true, t.Name()
	}
	out, _ := p.generic.Apply(text, maxChars)
	return out, len(out) < len(text), p.generic.Name()
}

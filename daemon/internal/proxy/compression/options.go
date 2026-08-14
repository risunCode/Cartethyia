package compression

// Quality selects a token-saver preset. The mapping mirrors src.old/open-sse/rtk:
//
//	lite      — generous budget, keep the last three turns untouched
//	balanced  — default; smaller budget, keep the last two turns
//	extreme   — tightest budget, keep only the last turn
type Quality string

const (
	QualityLite     Quality = "lite"
	QualityBalanced Quality = "balanced"
	QualityExtreme  Quality = "extreme"
)

// qualityLimits is the single source of truth for the per-quality thresholds.
// Keep in sync with QUALITY_LIMITS in src.old/open-sse/rtk/index.ts.
type qualityLimits struct {
	maxChars     int
	keepLastTurn int
}

var qualityLimitsByQuality = map[Quality]qualityLimits{
	QualityLite:     {maxChars: 8_000, keepLastTurn: 3},
	QualityBalanced: {maxChars: 4_000, keepLastTurn: 2},
	QualityExtreme:  {maxChars: 2_000, keepLastTurn: 1},
}

func limitsFor(q Quality) qualityLimits {
	if v, ok := qualityLimitsByQuality[q]; ok {
		return v
	}
	return qualityLimitsByQuality[QualityBalanced]
}

// EmergencyMessageThreshold is the message-count threshold below which the
// token saver is not consulted, even when invoked with Emergency=true.
const EmergencyMessageThreshold = 512

// PipelineOptions configures the local RTK-style token saver.
type PipelineOptions struct {
	// Enabled turns the local token saver on. When false, ApplyTokenSaver
	// returns the request unchanged and records Reason="disabled".
	Enabled bool

	// Quality selects the per-block byte budget and the number of recent
	// turns left untouched. Unknown values fall back to QualityBalanced.
	Quality Quality

	// SmartTruncate enables format-aware filters (git-diff, tree, grep, etc.).
	// When false the pipeline falls back to the generic head/tail truncator.
	// Nil means "default on" to match the legacy default.
	SmartTruncate *bool

	// Emergency forces the saver to run even when Enabled is false. This is
	// intended as a last-resort safety valve for huge request bodies.
	Emergency bool
}

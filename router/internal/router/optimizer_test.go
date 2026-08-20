package router

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func boolPtr(v bool) *bool { return &v }

func repeatRunes(ch rune, n int) string {
	return strings.Repeat(string(ch), n)
}

func toolRequest(model string, texts ...string) Request {
	msgs := make([]Message, 0, len(texts))
	for i, text := range texts {
		role := "assistant"
		if i%2 == 0 {
			role = "user"
		}
		msgs = append(msgs, Message{
			Role: role,
			Content: []Block{{
				Kind:       BlockToolResult,
				Text:       text,
				ToolCallID: "call-" + itoa(i),
				ToolName:   "tool",
			}},
		})
	}
	return Request{Model: model, Messages: msgs}
}

type errSetCache struct {
	MemoryCache
	setErr error
}

func (c *errSetCache) Set(key string, out Outcome) error {
	if c.setErr != nil {
		return c.setErr
	}
	return c.MemoryCache.Set(key, out)
}

type errGetCache struct{}

func (errGetCache) Get(string) (Outcome, bool, error) {
	return Outcome{}, false, errors.New("get failed")
}

func (errGetCache) Set(string, Outcome) error { return nil }

type stubTransform struct {
	name string
	out  string
	ok   bool
}

func (s stubTransform) Name() string { return s.name }
func (s stubTransform) Apply(string, int) (string, bool) {
	return s.out, s.ok
}

func TestApplyTokenSaverDisabled(t *testing.T) {
	in := toolRequest("m", repeatRunes('a', 6000))
	out := ApplyTokenSaver(in, nil, PipelineOptions{Enabled: false})
	if out.Summary.Attempted || out.Summary.Reason != ReasonDisabled {
		t.Fatalf("got %#v", out.Summary)
	}
	if out.Request.Messages[0].Content[0].Text != in.Messages[0].Content[0].Text {
		t.Fatal("disabled path mutated request")
	}
}

func TestApplyTokenSaverEmpty(t *testing.T) {
	out := ApplyTokenSaver(Request{Model: "m"}, NewPipeline(), PipelineOptions{Enabled: true})
	if out.Summary.Reason != ReasonEmpty || out.Summary.Attempted {
		t.Fatalf("empty messages: %#v", out.Summary)
	}

	// Emergency below threshold is also empty (skip).
	tiny := toolRequest("m", "short")
	out = ApplyTokenSaver(tiny, NewPipeline(), PipelineOptions{Enabled: false, Emergency: true})
	if out.Summary.Reason != ReasonEmpty {
		t.Fatalf("emergency below threshold: %#v", out.Summary)
	}
}

func TestApplyTokenSaverToolResultShorteningKeepLastAndMaxChars(t *testing.T) {
	// QualityExtreme: maxChars=2000, keepLastTurn=1 → keepLast=2 messages untouched.
	oldBig := repeatRunes('A', 5000)
	oldBig2 := repeatRunes('B', 5000)
	keep1 := repeatRunes('C', 5000)
	keep2 := repeatRunes('D', 5000)
	in := toolRequest("m", oldBig, oldBig2, keep1, keep2)

	smart := false // force generic truncator
	out := ApplyTokenSaver(in, NewPipeline(), PipelineOptions{
		Enabled:       true,
		Quality:       QualityExtreme,
		SmartTruncate: &smart,
	})
	if !out.Summary.Attempted || !out.Summary.HasShrunk() {
		t.Fatalf("expected shrink, got %#v", out.Summary)
	}
	if out.Summary.Filter != "generic" {
		t.Fatalf("filter=%q", out.Summary.Filter)
	}
	if out.Summary.CompressedBlocks != 2 {
		t.Fatalf("compressed blocks=%d want 2", out.Summary.CompressedBlocks)
	}

	got := out.Request.Messages
	if len(got[0].Content[0].Text) >= len(oldBig) || len(got[0].Content[0].Text) > 2000+80 {
		t.Fatalf("early tool result not shortened: len=%d", len(got[0].Content[0].Text))
	}
	if len(got[1].Content[0].Text) >= len(oldBig2) {
		t.Fatalf("second early tool result not shortened: len=%d", len(got[1].Content[0].Text))
	}
	// keep-last window must remain untouched.
	if got[2].Content[0].Text != keep1 || got[3].Content[0].Text != keep2 {
		t.Fatal("keep-last messages were mutated")
	}
	// Original input must stay intact (clone-on-write).
	if in.Messages[0].Content[0].Text != oldBig {
		t.Fatal("input mutated")
	}
}

func TestApplyTokenSaverNoShrinkSkips(t *testing.T) {
	// Text blocks and short tool results never shrink.
	in := Request{Model: "m", Messages: []Message{
		{Role: "user", Content: []Block{{Kind: BlockText, Text: repeatRunes('x', 6000)}}},
		{Role: "assistant", Content: []Block{{Kind: BlockToolResult, Text: "tiny"}}},
		{Role: "user", Content: []Block{{Kind: BlockToolResult, Text: ""}}},
		{Role: "assistant", Content: []Block{{Kind: BlockOther, Text: repeatRunes('y', 6000)}}},
	}}
	out := ApplyTokenSaver(in, NewPipeline(), PipelineOptions{Enabled: true, Quality: QualityExtreme})
	if out.Summary.Reason != ReasonNoShrink || out.Summary.Attempted {
		t.Fatalf("got %#v", out.Summary)
	}
}

func TestOrchestratorCacheErrorFailOpen(t *testing.T) {
	big := repeatRunes('Z', 5000)
	// More than keepLast=2 so compression runs.
	in := toolRequest("model-a", big, big, "recent-a", "recent-b")
	smart := false
	orch := &Orchestrator{
		Pipeline: NewPipeline(),
		Cache:    &errSetCache{setErr: errors.New("set boom")},
		TokenOpts: PipelineOptions{
			Enabled:       true,
			Quality:       QualityExtreme,
			SmartTruncate: &smart,
		},
	}
	res := orch.Run(context.Background(), in)
	if res.CacheHit {
		t.Fatal("unexpected cache hit")
	}
	if !res.TokenSummary.Attempted || res.TokenSummary.Reason != ReasonCacheError {
		t.Fatalf("expected fail-open cache error, got %#v", res.TokenSummary)
	}
	if len(res.Request.Messages[0].Content[0].Text) >= len(big) {
		t.Fatal("compression must still apply when cache Set fails")
	}
}

func TestOrchestratorCacheHitAndGetError(t *testing.T) {
	mem := NewMemoryCache()
	smart := false
	orch := &Orchestrator{
		Pipeline: NewPipeline(),
		Cache:    mem,
		TokenOpts: PipelineOptions{Enabled: true, Quality: QualityExtreme, SmartTruncate: &smart},
	}
	in := toolRequest("m", repeatRunes('q', 5000), repeatRunes('q', 5000), "a", "b")
	first := orch.Run(context.Background(), in)
	if first.CacheHit || !first.TokenSummary.Attempted {
		t.Fatalf("first run: %#v", first)
	}
	second := orch.Run(context.Background(), in)
	if !second.CacheHit {
		t.Fatal("expected cache hit")
	}
	if second.TokenSummary.Reason != ReasonCacheMiss {
		// Orchestrator stamps ReasonCacheMiss on hit path today.
		t.Fatalf("hit reason=%q", second.TokenSummary.Reason)
	}

	// Get error is treated as miss (fail-open).
	orch.Cache = errGetCache{}
	miss := orch.Run(context.Background(), in)
	if miss.CacheHit {
		t.Fatal("get error must not be a hit")
	}
}

func TestOrchestratorNilDefaultsAndDisabled(t *testing.T) {
	o := &Orchestrator{TokenOpts: PipelineOptions{Enabled: false}}
	res := o.Run(context.Background(), toolRequest("m", "x"))
	if res.TokenSummary.Reason != ReasonDisabled {
		t.Fatalf("got %#v", res.TokenSummary)
	}
	if o.Pipeline == nil || o.Cache == nil {
		t.Fatal("Run should install defaults")
	}

	def := NewOrchestrator()
	if def.Pipeline == nil || def.Cache == nil || !def.TokenOpts.Enabled {
		t.Fatalf("NewOrchestrator defaults: %#v", def)
	}
}

func TestCacheKeyOrderIndependentForToolCallIDs(t *testing.T) {
	a := Request{Model: "m", Messages: []Message{{
		Role: "user",
		Content: []Block{
			{Kind: BlockToolResult, ToolCallID: "b", Text: "two"},
			{Kind: BlockToolResult, ToolCallID: "a", Text: "one"},
		},
	}}}
	b := Request{Model: "m", Messages: []Message{{
		Role: "user",
		Content: []Block{
			{Kind: BlockToolResult, ToolCallID: "a", Text: "one"},
			{Kind: BlockToolResult, ToolCallID: "b", Text: "two"},
		},
	}}}
	if CacheKey(a) != CacheKey(b) {
		t.Fatal("CacheKey should sort by ToolCallID")
	}
	c := a.Clone()
	c.Model = "other"
	if CacheKey(a) == CacheKey(c) {
		t.Fatal("model must affect key")
	}
}

func TestMemoryAndNoopCache(t *testing.T) {
	var nilMem *MemoryCache
	if _, ok, err := nilMem.Get("k"); ok || err != nil || nilMem.Set("k", Outcome{}) != nil || nilMem.Len() != 0 {
		t.Fatal("nil MemoryCache must be safe")
	}
	mem := NewMemoryCache()
	out := Outcome{Request: Request{Model: "m"}, Summary: Summary{Attempted: true}}
	if err := mem.Set("k", out); err != nil {
		t.Fatal(err)
	}
	got, ok, err := mem.Get("k")
	if !ok || err != nil || got.Request.Model != "m" || mem.Len() != 1 {
		t.Fatalf("memory get: ok=%v err=%v got=%#v len=%d", ok, err, got, mem.Len())
	}
	var noop NoopCache
	if _, ok, err := noop.Get("k"); ok || err != nil || noop.Set("k", out) != nil {
		t.Fatal("NoopCache contract broken")
	}
}

func TestPipelineApplyTransformAndOverrides(t *testing.T) {
	var nilPipe *Pipeline
	if out, changed, name := nilPipe.ApplyTransform("abc", 1, true); changed || name != "" || out != "abc" {
		t.Fatal("nil pipeline must no-op")
	}

	p := NewPipeline().WithTransforms([]Transform{
		stubTransform{name: "skip", out: "", ok: false},
		stubTransform{name: "noshrink", out: repeatRunes('x', 100), ok: true},
		stubTransform{name: "shorten", out: "ok", ok: true},
	}).WithGeneric(stubTransform{name: "gen", out: "g", ok: true})

	out, changed, name := p.ApplyTransform(repeatRunes('x', 100), 10, true)
	if !changed || name != "shorten" || out != "ok" {
		t.Fatalf("smart path: %q %v %q", out, changed, name)
	}
	out, changed, name = p.ApplyTransform(repeatRunes('x', 100), 10, false)
	if !changed || name != "gen" || out != "g" {
		t.Fatalf("generic path: %q %v %q", out, changed, name)
	}
	out, changed, name = p.ApplyTransform("short", 100, true)
	if changed || name != "" || out != "short" {
		t.Fatalf("under budget: %q %v %q", out, changed, name)
	}

	// nil receiver builders + nil generic restore.
	p2 := (*Pipeline)(nil).WithTransforms(nil).WithGeneric(nil)
	if p2 == nil || p2.generic == nil {
		t.Fatal("builders on nil pipeline")
	}
	_ = NewPipeline().WithTransforms(nil).WithGeneric(nil)
}

func TestTypesHelpersAndLimits(t *testing.T) {
	in := Request{Model: "m", Messages: []Message{{Role: "user", Content: []Block{{Kind: BlockText, Text: "hi", ToolCallID: "t"}}}}}
	cl := in.Clone()
	cl.Messages[0].Content[0].Text = "mut"
	if in.Messages[0].Content[0].Text != "hi" {
		t.Fatal("Clone must deep-copy blocks")
	}
	skip := Skip(in, ReasonDisabled)
	if skip.Summary.Attempted || skip.Summary.Reason != ReasonDisabled {
		t.Fatalf("%#v", skip.Summary)
	}
	ok := Compressed(in, 100, 40, 2, "generic")
	if !ok.Summary.HasShrunk() || ok.Summary.CompressedBlocks != 2 || ok.Summary.Filter != "generic" {
		t.Fatalf("%#v", ok.Summary)
	}
	if (Summary{Attempted: true, BytesBefore: 10, BytesAfter: 10}).HasShrunk() {
		t.Fatal("equal bytes is not shrink")
	}
	if limitsFor(QualityLite).maxChars != 8000 || limitsFor(Quality("nope")).maxChars != limitsFor(QualityBalanced).maxChars {
		t.Fatal("limitsFor mapping broken")
	}
	if itoa(0) != "0" || itoa(-12) != "-12" || itoa(7) != "7" {
		t.Fatal("itoa")
	}
}

func TestFiltersAndAutoDetect(t *testing.T) {
	g := genericFilter{}
	if g.Name() != "generic" || g.Lossless() {
		t.Fatal("generic meta")
	}
	out, ok := g.Apply(repeatRunes('x', 5000), 1000)
	if !ok || len(out) >= 5000 || !strings.Contains(out, "truncated") {
		t.Fatalf("generic apply: ok=%v len=%d", ok, len(out))
	}
	if s, ok := g.Apply("abc", 0); ok || s != "abc" {
		t.Fatal("generic maxChars<=0")
	}

	// git-diff: long hunks get elided.
	var diff strings.Builder
	diff.WriteString("diff --git a/f b/f\n")
	diff.WriteString("@@ -1,40 +1,40 @@\n")
	for i := 0; i < 40; i++ {
		diff.WriteString("+line-" + itoa(i) + "-" + repeatRunes('d', 40) + "\n")
	}
	diff.WriteString("@@ -50,5 +50,5 @@\n")
	for i := 0; i < 5; i++ {
		diff.WriteString(" context\n")
	}
	gd := gitDiffFilter{}
	if gd.Name() != "git-diff" || gd.Lossless() {
		t.Fatal("git-diff meta")
	}
	dout, dok := gd.Apply(diff.String(), 2000)
	if !dok || len(dout) >= len(diff.String()) || !strings.Contains(dout, "hunk lines elided") {
		t.Fatalf("git-diff apply: ok=%v", dok)
	}
	// Over budget after elision forces generic fallback.
	dout, dok = gd.Apply(diff.String(), 80)
	if !dok || !strings.Contains(dout, "truncated") {
		t.Fatal("git-diff over budget")
	}
	// Non-diff under budget: unchanged. Over budget: generic fallback shortens.
	if out, ok := gd.Apply("not a diff\nline\n", 100); ok || out != "not a diff\nline\n" {
		t.Fatalf("non-diff under budget: ok=%v out=%q", ok, out)
	}
	if out, ok := gd.Apply(repeatRunes('n', 200)+"\n", 40); !ok || len(out) >= 200 {
		t.Fatalf("non-diff over budget should generic-truncate: ok=%v len=%d", ok, len(out))
	}

	gs := gitStatusFilter{}
	long := repeatRunes('p', 40)
	statusLines := []string{"On branch main", "## main...origin/main"}
	for i := 0; i < 15; i++ {
		statusLines = append(statusLines, "M  staged-"+itoa(i)+"-"+long+".go")
		statusLines = append(statusLines, " M dirty-"+itoa(i)+"-"+long+".go")
		statusLines = append(statusLines, "?? untracked-"+itoa(i)+"-"+long+".go")
	}
	status := strings.Join(statusLines, "\n")
	sout, sok := gs.Apply(status, 0)
	if !sok || !strings.Contains(sout, "Untracked") || !strings.Contains(sout, "Staged") || !strings.Contains(sout, "more") {
		t.Fatalf("git-status: %q", sout)
	}
	if _, ok := gs.Apply("hello\nworld\n", 0); ok {
		t.Fatal("non-status")
	}
	_ = gs.Name()
	_ = gs.Lossless()

	tr := treeFilter{}
	var tree strings.Builder
	tree.WriteString(".\n")
	for i := 0; i < 80; i++ {
		tree.WriteString("│  │  deep-" + itoa(i) + "\n")
		tree.WriteString("├── top-" + itoa(i) + "\n")
	}
	tout, tok := tr.Apply(tree.String(), 400)
	if !tok || !strings.Contains(tout, "deeper entries collapsed") {
		t.Fatalf("tree: ok=%v out=%q", tok, tout)
	}
	_ = tr.Name()
	_ = tr.Lossless()

	rn := readNumberedFilter{}
	var numbered strings.Builder
	for i := 1; i <= 200; i++ {
		numbered.WriteString("  " + itoa(i) + "→ " + repeatRunes('n', 30) + "\n")
	}
	nout, nok := rn.Apply(numbered.String(), 500)
	if !nok || !strings.Contains(nout, "numbered lines elided") {
		t.Fatalf("read-numbered: ok=%v", nok)
	}
	if _, ok := rn.Apply("short", 500); ok {
		t.Fatal("read-numbered under budget")
	}
	_ = rn.Name()
	_ = rn.Lossless()

	gr := grepFilter{}
	var grep strings.Builder
	for i := 0; i < 20; i++ {
		grep.WriteString("pkg/file.go:" + itoa(100+i) + ": match body " + itoa(i) + "\n")
	}
	grep.WriteString("other/path.go:9: more\n")
	gout, gok := gr.Apply(grep.String(), 2000)
	if !gok || !strings.Contains(gout, "RTK grep summary") || !strings.Contains(gout, "more") {
		t.Fatalf("grep: %q", gout)
	}
	if _, ok := gr.Apply("not grep output\n", 100); ok {
		t.Fatal("non-grep")
	}
	if path, num, rest, ok := splitGrepLine("a.go:12: hi"); !ok || path != "a.go" || num != "12" || rest != " hi" {
		t.Fatalf("splitGrepLine good: %v %q %q %q", ok, path, num, rest)
	}
	if _, _, _, ok := splitGrepLine("bad line"); ok {
		t.Fatal("splitGrepLine bad")
	}
	if _, _, _, ok := splitGrepLine("has space:1:x"); ok {
		t.Fatal("splitGrepLine space path")
	}
	_ = gr.Name()
	_ = gr.Lossless()

	dl := dedupLogFilter{}
	dup := strings.Repeat("same line\n", 8) + "other\n" + strings.Repeat("same line\n", 2)
	duout, duok := dl.Apply(dup, 0)
	if !duok || !strings.Contains(duout, "lines") || len(duout) >= len(dup) {
		t.Fatalf("dedup-log: %q", duout)
	}
	if _, ok := dl.Apply("a\nb\nc\n", 0); ok {
		t.Fatal("dedup no duplicates")
	}
	if !dl.Lossless() || dl.Name() != "dedup-log" {
		t.Fatal("dedup meta")
	}

	// AutoDetect branches.
	cases := []struct {
		in   string
		want string
	}{
		{"diff --git a/x b/x\n@@ -1 +1 @@\n", "git-diff"},
		{"On branch main\nnothing to commit\n", "git-status"},
		{" M a.go\n M b.go\n?? c.go\n", "git-status"},
		{"src/a.go:10: hit\nsrc/a.go:11: hit2\n", "grep"},
		{"./a/b\n./c/d\n./e/f\n", "tree"},
		{"├── root\n│  child\n", "tree"},
		{"  1→ one\n  2→ two\n  3→ three\n  4→ four\n  5→ five\n", "read-numbered"},
		{"x\nx\nx\nx\ny\n", "dedup-log"},
		{"hello world\n", ""},
	}
	for _, tc := range cases {
		if got := AutoDetect(tc.in); got != tc.want {
			t.Fatalf("AutoDetect(%q)=%q want %q", tc.in, got, tc.want)
		}
	}
	// Probe window trim still detects.
	head := "diff --git a/z b/z\n" + repeatRunes('z', filterProbeWindow)
	if AutoDetect(head) != "git-diff" {
		t.Fatal("probe window")
	}
	if !isPathLike(`C:\foo\bar`) || !isPathLike("/tmp/x") || isPathLike("nope") || isPathLike("a:b") {
		t.Fatal("isPathLike")
	}
	if isMostlyPorcelain("a\nb\n") {
		t.Fatal("porcelain too short")
	}
}

func TestApplyTokenSaverSmartTruncateDefaultAndPipelineNil(t *testing.T) {
	in := toolRequest("m",
		"diff --git a/f b/f\n@@ -1,30 +1,30 @@\n"+strings.Repeat("+zzzzzzzzzzzzzzzzzzzzzzzzzzzz\n", 40),
		repeatRunes('y', 100),
		"keep-a",
		"keep-b",
	)
	out := ApplyTokenSaver(in, nil, PipelineOptions{Enabled: true, Quality: QualityExtreme})
	if !out.Summary.Attempted {
		// May or may not shrink depending on filter; ensure nil pipeline is accepted.
		if out.Summary.Reason != ReasonNoShrink {
			t.Fatalf("%#v", out.Summary)
		}
	}
	// Explicit SmartTruncate=true with oversized generic text.
	in2 := toolRequest("m", repeatRunes('G', 5000), repeatRunes('H', 5000), "a", "b")
	out2 := ApplyTokenSaver(in2, NewPipeline(), PipelineOptions{
		Enabled:       true,
		Quality:       QualityExtreme,
		SmartTruncate: boolPtr(true),
	})
	if !out2.Summary.Attempted || out2.Summary.Filter == "" {
		t.Fatalf("smart default path: %#v", out2.Summary)
	}
}

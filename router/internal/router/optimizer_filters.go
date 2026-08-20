package router

import (
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
)

// filterThreshold is the minimum text length, in runes, below which the smart
// pipeline never engages. It is intentionally identical to the legacy
// MIN_COMPRESSIBLE constant so behavior matches.
const filterThreshold = 500

// filterProbeWindow bounds how many leading bytes each filter inspects when
// deciding whether its detector regex matches.
const filterProbeWindow = 8_192

// ---- Generic head/tail truncator -------------------------------------------

type genericFilter struct{}

func (genericFilter) Name() string   { return "generic" }
func (genericFilter) Lossless() bool { return false }

// Apply keeps the first 70% of the budget as head, an ellipsis line with the
// dropped count, and as much of the tail as fits in the remaining 30% (minus
// the 80-byte ellipsis allowance). The math mirrors src.old/open-sse/rtk.
func (genericFilter) Apply(text string, maxChars int) (string, bool) {
	if maxChars <= 0 {
		return text, false
	}
	headSize := maxChars * 7 / 10
	tailSize := maxChars - headSize - 80
	if tailSize < 0 {
		tailSize = 0
	}
	var tail string
	if tailSize > 0 && len(text) > tailSize {
		tail = text[len(text)-tailSize:]
	}
	midStart := headSize
	midEnd := len(text) - len(tail)
	if midEnd < midStart {
		midEnd = midStart
	}
	dropped := len(text) - headSize - len(tail)
	mid := text[midStart:midEnd]
	lines := strings.Count(mid, "\n")
	var b strings.Builder
	b.Grow(headSize + len(tail) + 64)
	b.WriteString(text[:headSize])
	b.WriteString("\n\n…[truncated ")
	b.WriteString(itoa(dropped))
	b.WriteString(" chars / ~")
	b.WriteString(itoa(lines))
	b.WriteString(" lines]…\n\n")
	b.WriteString(tail)
	return b.String(), true
}

// itoa is a local int->string helper to avoid pulling strconv into every
// allocation path; the values are bounded (max int32-ish in practice) so the
// 20-byte stack buffer is always enough.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// ---- Git diff ---------------------------------------------------------------

var reDiffHunk = regexp.MustCompile(`^@@ .+ @@`)

type gitDiffFilter struct{}

func (gitDiffFilter) Name() string   { return "git-diff" }
func (gitDiffFilter) Lossless() bool { return false }

func (gitDiffFilter) Apply(text string, maxChars int) (string, bool) {
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	for i := 0; i < len(lines); {
		if !reDiffHunk.MatchString(lines[i]) {
			out = append(out, lines[i])
			i++
			continue
		}
		start := i
		i++
		for i < len(lines) && !reDiffHunk.MatchString(lines[i]) && !strings.HasPrefix(lines[i], "diff --git ") {
			i++
		}
		hunk := lines[start:i]
		if len(hunk) <= 11 {
			out = append(out, hunk...)
			continue
		}
		out = append(out, hunk[0])
		out = append(out, hunk[1:6]...)
		out = append(out, "…["+itoa(len(hunk)-11)+" hunk lines elided]…")
		out = append(out, hunk[len(hunk)-5:]...)
	}
	joined := strings.Join(out, "\n")
	if len(joined) > maxChars {
		g := genericFilter{}
		s, _ := g.Apply(joined, maxChars)
		return s, true
	}
	if len(joined) < len(text) {
		return joined, true
	}
	return text, false
}

// ---- Git status -------------------------------------------------------------

type gitStatusFilter struct{}

func (gitStatusFilter) Name() string   { return "git-status" }
func (gitStatusFilter) Lossless() bool { return false }

func (gitStatusFilter) Apply(text string, _ int) (string, bool) {
	var staged, modified, untracked []string
	branch := ""
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimRight(raw, "\r")
		if strings.HasPrefix(line, "On branch ") {
			branch = line[len("On branch "):]
			continue
		}
		if strings.HasPrefix(line, "## ") {
			branch = line[3:]
		}
		if len(raw) < 3 || raw[2] != ' ' {
			continue
		}
		path := raw[3:]
		if strings.HasPrefix(raw, "?? ") {
			untracked = append(untracked, path)
			continue
		}
		if len(raw) > 0 {
			if strings.ContainsRune("MADRCU?!", rune(raw[0])) {
				staged = append(staged, path)
			}
			if len(raw) > 1 && raw[1] == 'M' {
				modified = append(modified, path)
			}
		}
	}
	if len(staged)+len(modified)+len(untracked) == 0 {
		return text, false
	}
	section := func(label string, entries []string) []string {
		if len(entries) == 0 {
			return nil
		}
		out := make([]string, 0, len(entries)+2)
		out = append(out, label+": "+itoa(len(entries)))
		for i, e := range entries {
			if i >= 10 {
				out = append(out, "  … +"+itoa(len(entries)-10)+" more")
				break
			}
			out = append(out, "  "+e)
		}
		return out
	}
	parts := []string{}
	if branch != "" {
		parts = append(parts, "* "+branch)
	}
	parts = append(parts, section("Staged", staged)...)
	parts = append(parts, section("Modified", modified)...)
	parts = append(parts, section("Untracked", untracked)...)
	out := strings.Join(parts, "\n")
	if len(out) >= len(text) {
		return text, false
	}
	return out, true
}

// ---- Tree -------------------------------------------------------------------

type treeFilter struct{}

func (treeFilter) Name() string   { return "tree" }
func (treeFilter) Lossless() bool { return false }

func (treeFilter) Apply(text string, maxChars int) (string, bool) {
	kept := make([]string, 0, 16)
	dropped := 0
	var b strings.Builder
	for _, line := range strings.Split(text, "\n") {
		indent := 0
		i := 0
		for i+1 < len(line) {
			r1, sz1 := utf8.DecodeRuneInString(line[i:])
			r2, sz2 := utf8.DecodeRuneInString(line[i+sz1:])
			if sz1 == 0 || sz2 == 0 || (r1 != '│' && r1 != ' ') || r2 != ' ' {
				break
			}
			indent++
			i += sz1 + sz2
		}
		if indent <= 1 {
			kept = append(kept, line)
		} else {
			dropped++
		}
		if b.Len()+len(line)+1 > maxChars-100 {
			break
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	out := b.String() + "…[" + itoa(dropped) + " deeper entries collapsed]…"
	if len(out) < len(text) {
		return out, true
	}
	return text, false
}

// ---- Read-numbered ----------------------------------------------------------

type readNumberedFilter struct{}

func (readNumberedFilter) Name() string   { return "read-numbered" }
func (readNumberedFilter) Lossless() bool { return false }

func (readNumberedFilter) Apply(text string, maxChars int) (string, bool) {
	if len(text) <= maxChars {
		return text, false
	}
	lines := strings.Split(text, "\n")
	var head, tail []string
	headSize, tailSize := 0, 0
	for _, line := range lines {
		if headSize+len(line) > maxChars*6/10 {
			break
		}
		head = append(head, line)
		headSize += len(line) + 1
	}
	for i := len(lines) - 1; i >= 0; i-- {
		line := lines[i]
		if tailSize+len(line) > maxChars*3/10 {
			break
		}
		tail = append([]string{line}, tail...)
		tailSize += len(line) + 1
	}
	out := strings.Join(head, "\n")
	if middle := len(lines) - len(head) - len(tail); middle > 0 {
		out += "\n…[" + itoa(middle) + " numbered lines elided]…\n" + strings.Join(tail, "\n")
	} else if len(tail) > 0 {
		out += "\n" + strings.Join(tail, "\n")
	}
	if len(out) < len(text) {
		return out, true
	}
	return text, false
}

// ---- Grep summary -----------------------------------------------------------

type grepFilter struct{}

func (grepFilter) Name() string   { return "grep" }
func (grepFilter) Lossless() bool { return false }

func (grepFilter) Apply(text string, maxChars int) (string, bool) {
	groups := map[string][]string{}
	for _, line := range strings.Split(text, "\n") {
		path, num, rest, ok := splitGrepLine(line)
		if !ok {
			continue
		}
		groups[path] = append(groups[path], num+": "+strings.TrimSpace(rest))
	}
	if len(groups) == 0 {
		return text, false
	}
	var b strings.Builder
	b.WriteString("RTK grep summary:\n")
	for path, matches := range groups {
		b.WriteString("[")
		b.WriteString(path)
		b.WriteString("] (")
		b.WriteString(itoa(len(matches)))
		b.WriteString(")\n")
		for i, m := range matches {
			if i >= 5 {
				b.WriteString("  … +")
				b.WriteString(itoa(len(matches) - 5))
				b.WriteString(" more\n")
				break
			}
			b.WriteString("  ")
			b.WriteString(m)
			b.WriteByte('\n')
		}
		if b.Len() > maxChars {
			break
		}
	}
	out := b.String()
	if len(out) < len(text) {
		return out, true
	}
	return text, false
}

func splitGrepLine(line string) (path, num, rest string, ok bool) {
	idx := strings.IndexByte(line, ':')
	if idx <= 0 {
		return "", "", "", false
	}
	if strings.ContainsAny(line[:idx], " \t") {
		return "", "", "", false
	}
	restStart := idx + 1
	restEnd := restStart
	for restEnd < len(line) && line[restEnd] >= '0' && line[restEnd] <= '9' {
		restEnd++
	}
	if restEnd == restStart || restEnd >= len(line) || line[restEnd] != ':' {
		return "", "", "", false
	}
	return line[:idx], line[restStart:restEnd], line[restEnd+1:], true
}

// ---- Dedup log (lossless) ----------------------------------------------------

type dedupLogFilter struct{}

func (dedupLogFilter) Name() string   { return "dedup-log" }
func (dedupLogFilter) Lossless() bool { return true }

func (dedupLogFilter) Apply(text string, _ int) (string, bool) {
	var b strings.Builder
	var prev string
	prevSet := false
	dupes := 0
	flush := func() {
		if dupes == 0 {
			return
		}
		word := "lines"
		if dupes == 1 {
			word = "line"
		}
		b.WriteString("  … (")
		b.WriteString(itoa(dupes))
		b.WriteByte(' ')
		b.WriteString(word)
		b.WriteString(")\n")
	}
	for _, line := range strings.Split(text, "\n") {
		if prevSet && line == prev {
			dupes++
			continue
		}
		flush()
		b.WriteString(line)
		b.WriteByte('\n')
		prev = line
		prevSet = true
		dupes = 0
	}
	flush()
	out := b.String()
	if len(out) < len(text) {
		return out, true
	}
	return text, false
}

// ---- Auto-detect ------------------------------------------------------------

// AutoDetect returns the most likely filter for text, mirroring
// autoDetectFilter in src.old/open-sse/rtk/autodetect.ts. The result is a
// recommendation only; the pipeline is free to ignore it.
func AutoDetect(text string) string {
	head := text
	if len(head) > filterProbeWindow {
		head = head[:filterProbeWindow]
	}
	if matchedAny(head, `(?m)^diff --git |^@@ `) {
		return "git-diff"
	}
	if matchedAny(head, `(?m)^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:`) || isMostlyPorcelain(head) {
		return "git-status"
	}
	lines := strings.Split(head, "\n")
	nonEmpty := make([]string, 0, len(lines))
	for _, l := range lines {
		if strings.TrimSpace(l) != "" {
			nonEmpty = append(nonEmpty, l)
		}
	}
	for i := range min(len(nonEmpty), 5) {
		if matchedAny(nonEmpty[i], `^[^\s:]+:\d+:`) {
			return "grep"
		}
	}
	if len(nonEmpty) >= 3 {
		allPath := true
		for _, l := range nonEmpty {
			if !isPathLike(l) {
				allPath = false
				break
			}
		}
		if allPath {
			return "tree"
		}
	}
	if matchedAny(head, `[├└]──|│  `) || matchedAny(head, `(?m)^[-dlbcps][rwx-]{9}`) {
		return "tree"
	}
	if len(lines) >= 5 {
		numCount := 0
		for _, l := range lines {
			if l == "" {
				continue
			}
			if matchedAny(l, `^\s*\d+[→|\t]\s`) {
				numCount++
			}
		}
		if float64(numCount)/float64(len(nonEmpty)+1) >= 0.6 {
			return "read-numbered"
		}
	}
	if hasAdjacentDuplicates(nonEmpty) >= 3 {
		return "dedup-log"
	}
	return ""
}

func isMostlyPorcelain(text string) bool {
	lines := strings.Split(text, "\n")
	nonEmpty := 0
	porcelain := 0
	for _, l := range lines {
		if strings.TrimSpace(l) == "" {
			continue
		}
		nonEmpty++
		if matchedAny(l, `^[ MADRCU?!][ MADRCU?!] \S`) {
			porcelain++
		}
	}
	if nonEmpty < 3 {
		return false
	}
	return float64(porcelain)/float64(nonEmpty) >= 0.6
}

func isPathLike(line string) bool {
	v := strings.TrimSpace(line)
	if v == "" {
		return false
	}
	if len(v) >= 3 && ((v[0] >= 'A' && v[0] <= 'Z') || (v[0] >= 'a' && v[0] <= 'z')) && v[1] == ':' && (v[2] == '\\' || v[2] == '/') {
		return true
	}
	if strings.Contains(v, ":") {
		return false
	}
	return strings.HasPrefix(v, ".") || strings.HasPrefix(v, "/") || strings.Contains(v, "/")
}

func hasAdjacentDuplicates(lines []string) int {
	dupes := 0
	for i := 1; i < len(lines); i++ {
		if lines[i] == lines[i-1] {
			dupes++
		}
	}
	return dupes
}

// matchedAny is a tiny wrapper around regexp that caches nothing and is
// intentionally cheap for the small set of detection patterns above. It is
// not used on the hot per-token path; only AutoDetect and the per-filter
// detection branch consult it.
var detectorCache sync.Map //nolint:unused // reserved for future callers

type compiledDetector struct {
	re *regexp.Regexp
}

func compileDetector(pattern string) *compiledDetector {
	if v, ok := detectorCache.Load(pattern); ok {
		return v.(*compiledDetector)
	}
	re := regexp.MustCompile(pattern)
	d := &compiledDetector{re: re}
	detectorCache.Store(pattern, d)
	return d
}

func matchedAny(haystack, pattern string) bool {
	return compileDetector(pattern).re.MatchString(haystack)
}

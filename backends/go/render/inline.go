// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

// Package render is the read side of Super Editor: inline and block markdown, the Markdown, HTML and plain
// text exports, the outline and block queries, and document statistics. It ports inline.ts, markdown.ts,
// query.ts and stats.ts of the TypeScript reference; conformance/render.v1.json pins every behaviour.
//
// Documents are the generic values of package validation (maps, slices, float64 numbers, strings). The
// reference works on UTF-16 strings; here text is processed by code point, which agrees for the Basic
// Multilingual Plane and differs only in how astral characters count against the parser's size limits.
package render

import (
	"strings"
	"unicode"

	"github.com/Super-Solution/super-editor/backends/go/validation"
)

type record = map[string]any

// Run is an inline run: text with formatting and an optional citation marker.
type Run struct {
	Text                                  string
	Bold, Italic, Code, Strike, Underline bool
	Href, Highlight                       string
	CitationID                            string
	HasCitation                           bool
}

func (r Run) record() record {
	out := record{"text": r.Text}
	if r.Bold {
		out["bold"] = true
	}
	if r.Italic {
		out["italic"] = true
	}
	if r.Code {
		out["code"] = true
	}
	if r.Strike {
		out["strike"] = true
	}
	if r.Underline {
		out["underline"] = true
	}
	if r.Href != "" {
		out["href"] = r.Href
	}
	if r.Highlight != "" {
		out["highlight"] = r.Highlight
	}
	if r.HasCitation {
		out["citationId"] = r.CitationID
	}
	return out
}

// RunsOf reads the runs of a paragraph, quote or callout content (nil for other types).
func RunsOf(content record) []Run {
	switch content["type"] {
	case "paragraph", "quote", "callout":
		return runsFromAny(content["runs"])
	}
	return nil
}

func runsFromAny(v any) []Run {
	list, _ := v.([]any)
	out := make([]Run, len(list))
	for i, item := range list {
		m, _ := item.(record)
		r := Run{}
		r.Text, _ = m["text"].(string)
		r.Bold, _ = m["bold"].(bool)
		r.Italic, _ = m["italic"].(bool)
		r.Code, _ = m["code"].(bool)
		r.Strike, _ = m["strike"].(bool)
		r.Underline, _ = m["underline"].(bool)
		r.Href, _ = m["href"].(string)
		r.Highlight, _ = m["highlight"].(string)
		if id, ok := m["citationId"].(string); ok {
			r.CitationID, r.HasCitation = id, true
		}
		out[i] = r
	}
	return out
}

// RunsToAny converts runs to the generic JSON form.
func RunsToAny(runs []Run) []any {
	out := make([]any, len(runs))
	for i, r := range runs {
		out[i] = r.record()
	}
	return out
}

// PlainRuns is one unformatted run, or none for empty text.
func PlainRuns(text string) []Run {
	if text == "" {
		return []Run{}
	}
	return []Run{{Text: text}}
}

func sameFormat(a, b Run) bool {
	return a.Bold == b.Bold && a.Italic == b.Italic && a.Code == b.Code && a.Href == b.Href && a.Strike == b.Strike &&
		a.Underline == b.Underline && a.Highlight == b.Highlight && !a.HasCitation && !b.HasCitation
}

// NormalizeRuns merges neighbours with identical formatting and drops empty runs (citation markers excepted).
func NormalizeRuns(runs []Run) []Run {
	out := []Run{}
	for _, r := range runs {
		if r.Text == "" && !r.HasCitation {
			continue
		}
		if n := len(out); n > 0 && sameFormat(out[n-1], r) {
			out[n-1].Text += r.Text
		} else {
			out = append(out, r)
		}
	}
	return out
}

// ---- JavaScript character classes --------------------------------------------------------------------------------

// isJSSpace is JavaScript's \s: WhiteSpace and LineTerminator.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', 0x0b, 0x0c, '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func isLineTerminator(r rune) bool { return r == '\n' || r == '\r' || r == 0x2028 || r == 0x2029 }

func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

func jsTrimLeft(s string) string { return strings.TrimLeftFunc(s, isJSSpace) }

func jsTrimRight(s string) string { return strings.TrimRightFunc(s, isJSSpace) }

// A word character as the reference tests it on one UTF-16 code unit: astral characters are surrogate halves there.
func isWord(r rune) bool { return r <= 0xFFFF && (unicode.IsLetter(r) || unicode.IsNumber(r)) }

const escapable = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"

const maxDepth = 6

type context struct{ budget int }

func charAt(src []rune, i int) (rune, bool) {
	if i < 0 || i >= len(src) {
		return 0, false
	}
	return src[i], true
}

func spaceAt(src []rune, i int) bool {
	r, ok := charAt(src, i)
	return !ok || isJSSpace(r)
}

func wordAt(src []rune, i int) bool {
	r, ok := charAt(src, i)
	return ok && isWord(r)
}

func backtickRun(src []rune, i int) int {
	n := 0
	for i+n < len(src) && src[i+n] == '`' {
		n++
	}
	return n
}

func findBackticks(src []rune, from, count int, ctx *context) int {
	for i := from; i < len(src); i++ {
		ctx.budget--
		if ctx.budget < 0 {
			return -1
		}
		if src[i] != '`' {
			continue
		}
		n := backtickRun(src, i)
		if n == count {
			return i
		}
		i += n - 1
	}
	return -1
}

func startsWith(src []rune, i int, token string) bool {
	t := []rune(token)
	if i+len(t) > len(src) {
		return false
	}
	for j, r := range t {
		if src[i+j] != r {
			return false
		}
	}
	return true
}

func canOpen(src []rune, i int, delim string) bool {
	if spaceAt(src, i+len(delim)) {
		return false
	}
	return delim != "_" || !wordAt(src, i-1)
}

func canClose(src []rune, i int, delim string) bool {
	if spaceAt(src, i-1) {
		return false
	}
	return delim != "_" || !wordAt(src, i+1)
}

func findClose(src []rune, from int, delim string, ctx *context) int {
	for i := from; i < len(src); i++ {
		ctx.budget--
		if ctx.budget < 0 {
			return -1
		}
		c := src[i]
		if c == '\\' {
			i++
			continue
		}
		if c == '`' {
			n := backtickRun(src, i)
			closeAt := findBackticks(src, i+n, n, ctx)
			if closeAt >= 0 {
				i = closeAt + n - 1
			} else {
				i = i + n - 1
			}
			continue
		}
		if !startsWith(src, i, delim) {
			continue
		}
		if len(delim) == 1 && i+1 < len(src) && src[i+1] == rune(delim[0]) {
			i++
			continue
		}
		if canClose(src, i, delim) {
			return i
		}
	}
	return -1
}

func matchBracket(src []rune, open int, ctx *context) int {
	depth := 0
	for i := open; i < len(src) && i < open+2000; i++ {
		ctx.budget--
		if ctx.budget < 0 {
			return -1
		}
		switch src[i] {
		case '\\':
			i++
		case '[':
			depth++
		case ']':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

type marks struct {
	bold, italic, strike, code bool
	href                       string
}

var delimiters = []struct {
	token string
	add   func(*marks)
}{
	{"***", func(m *marks) { m.bold, m.italic = true, true }},
	{"**", func(m *marks) { m.bold = true }},
	{"~~", func(m *marks) { m.strike = true }},
	{"*", func(m *marks) { m.italic = true }},
	{"_", func(m *marks) { m.italic = true }},
}

func (m marks) run(text string) Run {
	return Run{Text: text, Bold: m.bold, Italic: m.italic, Strike: m.strike, Code: m.code, Href: m.href}
}

func isCitationChar(r rune, first bool) bool {
	if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
		return true
	}
	return !first && (r == '.' || r == '_' || r == ':' || r == '-')
}

// citationMarker matches /^\[\^([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\]/ at the start of src and returns the id and length.
func citationMarker(src []rune) (string, int, bool) {
	if len(src) < 4 || src[0] != '[' || src[1] != '^' {
		return "", 0, false
	}
	i := 2
	for i < len(src) && i-2 < 128 && isCitationChar(src[i], i == 2) {
		i++
	}
	if i == 2 || i >= len(src) || src[i] != ']' {
		return "", 0, false
	}
	return string(src[2:i]), i + 1, true
}

func slice(src []rune, from, to int) []rune {
	if from < 0 {
		from = 0
	}
	if to > len(src) {
		to = len(src)
	}
	if from >= to {
		return nil
	}
	return src[from:to]
}

func parse(src []rune, m marks, depth int, out *[]Run, ctx *context) {
	var buffer []rune
	flush := func() {
		if len(buffer) > 0 {
			*out = append(*out, m.run(string(buffer)))
		}
		buffer = nil
	}
	i := 0
scan:
	for i < len(src) {
		c := src[i]
		if c == '\\' && i+1 < len(src) && strings.ContainsRune(escapable, src[i+1]) {
			buffer = append(buffer, src[i+1])
			i += 2
			continue
		}
		if c == '`' {
			n := backtickRun(src, i)
			closeAt := findBackticks(src, i+n, n, ctx)
			if closeAt >= 0 {
				code := string(src[i+n : closeAt])
				if cr := []rune(code); len(cr) > 1 && cr[0] == ' ' && cr[len(cr)-1] == ' ' && jsTrim(code) != "" {
					code = string(cr[1 : len(cr)-1])
				}
				flush()
				r := m.run(code)
				r.Code = true
				*out = append(*out, r)
				i = closeAt + n
				continue
			}
			for k := 0; k < n; k++ {
				buffer = append(buffer, '`')
			}
			i += n
			continue
		}
		if c == '[' {
			if id, length, ok := citationMarker(slice(src, i, i+134)); ok {
				flush()
				*out = append(*out, Run{Text: "", CitationID: id, HasCitation: true})
				i += length
				continue
			}
		}
		// An image has no inline form, so ![alt](url) becomes a link labelled with the alt text.
		imageLink := c == '!' && i+1 < len(src) && src[i+1] == '['
		if (c == '[' || imageLink) && depth < maxDepth {
			open := i
			if imageLink {
				open = i + 1
			}
			closeAt := matchBracket(src, open, ctx)
			if closeAt > 0 && closeAt+1 < len(src) && src[closeAt+1] == '(' {
				tail := slice(src, closeAt+2, closeAt+4200)
				end := -1
				for k, r := range tail {
					if r == ')' {
						end = k
						break
					}
				}
				if end >= 0 {
					target := linkTarget(string(src[closeAt+2 : closeAt+2+end]))
					if href, ok := validation.SafeURL(target, false); ok {
						flush()
						inner := slice(src, open+1, closeAt)
						if len(inner) == 0 {
							inner = []rune(href)
						}
						next := m
						next.href = href
						parse(inner, next, depth+1, out, ctx)
						i = closeAt + 2 + end + 1
						continue
					}
				}
			}
		}
		if depth < maxDepth {
			for _, d := range delimiters {
				if !startsWith(src, i, d.token) || !canOpen(src, i, d.token) {
					continue
				}
				closeAt := findClose(src, i+len(d.token), d.token, ctx)
				if closeAt <= i+len(d.token) {
					continue
				}
				flush()
				next := m
				d.add(&next)
				parse(src[i+len(d.token):closeAt], next, depth+1, out, ctx)
				i = closeAt + len(d.token)
				continue scan
			}
		}
		buffer = append(buffer, c)
		i++
	}
	flush()
}

// linkTarget is `trim().split(/\s+/u)[0].replace(/^<|>$/g, ”)`.
func linkTarget(s string) string {
	t := jsTrim(s)
	if fields := strings.IndexFunc(t, isJSSpace); fields >= 0 {
		t = t[:fields]
	}
	t = strings.TrimPrefix(t, "<")
	t = strings.TrimSuffix(t, ">")
	return t
}

// ParseInline parses inline markdown-lite into runs. Unmatched markers stay literal text, so arbitrary prose is safe.
func ParseInline(markdown string) []Run {
	out := []Run{}
	parse([]rune(markdown), marks{}, 0, &out, &context{budget: 2_000_000})
	return NormalizeRuns(out)
}

// ---- serialization -----------------------------------------------------------------------------------------------------

func isWordByte(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_'
}

// EscapeInline escapes inline markdown specials. Line-start constructs are escaped separately by EscapeLineStarts.
func EscapeInline(text string) string {
	var first strings.Builder
	for _, r := range text {
		if strings.ContainsRune("\\`*_~[]<", r) {
			first.WriteByte('\\')
		}
		first.WriteRune(r)
	}
	src := []rune(first.String())
	var out strings.Builder
	for i, r := range src {
		if r == '&' {
			j := i + 1
			if j < len(src) && src[j] == '#' {
				j++
			}
			k := j
			for k < len(src) && isWordByte(src[k]) {
				k++
			}
			if k > j && k < len(src) && src[k] == ';' {
				out.WriteByte('\\')
			}
		}
		out.WriteRune(r)
	}
	return out.String()
}

// lineStarts lists the offsets where a multiline ^ matches: the start and after every line terminator.
func lineStarts(src []rune) []int {
	starts := []int{0}
	for i, r := range src {
		if isLineTerminator(r) {
			starts = append(starts, i+1)
		}
	}
	return starts
}

// atLineEnd is a multiline $: the end of the text or just before a line terminator.
func atLineEnd(src []rune, i int) bool { return i >= len(src) || isLineTerminator(src[i]) }

func spacesAt(src []rune, i int) int {
	n := 0
	for n < 3 && i+n < len(src) && src[i+n] == ' ' {
		n++
	}
	return n
}

// insertBackslashes puts a backslash before the rune at each given offset.
func insertBackslashes(src []rune, at []int) string {
	if len(at) == 0 {
		return string(src)
	}
	var out strings.Builder
	next := 0
	for i, r := range src {
		if next < len(at) && at[next] == i {
			out.WriteByte('\\')
			next++
		}
		out.WriteRune(r)
	}
	return out.String()
}

func nextIsSpaceOrEnd(src []rune, i int) bool { return atLineEnd(src, i) || isJSSpace(src[i]) }

// EscapeLineStarts escapes constructs that would start a block when they begin a line: headings, quotes, list
// markers, ordered markers and setext underlines.
func EscapeLineStarts(text string) string {
	// Pass 1: /^( {0,3})(#{1,6}(?=\s|$)|>|[-+](?=\s|$))/gm
	src := []rune(text)
	var at []int
	for _, start := range lineStarts(src) {
		p := start + spacesAt(src, start)
		if p >= len(src) {
			continue
		}
		switch {
		case src[p] == '#':
			n := 0
			for p+n < len(src) && src[p+n] == '#' {
				n++
			}
			if n <= 6 && nextIsSpaceOrEnd(src, p+n) {
				at = append(at, p)
			}
		case src[p] == '>':
			at = append(at, p)
		case (src[p] == '-' || src[p] == '+') && nextIsSpaceOrEnd(src, p+1):
			at = append(at, p)
		}
	}
	src = []rune(insertBackslashes(src, at))
	// Pass 2: /^( {0,3}\d+)([.)])(?=\s|$)/gm
	at = nil
	for _, start := range lineStarts(src) {
		p := start + spacesAt(src, start)
		q := p
		for q < len(src) && src[q] >= '0' && src[q] <= '9' {
			q++
		}
		if q > p && q < len(src) && (src[q] == '.' || src[q] == ')') && nextIsSpaceOrEnd(src, q+1) {
			at = append(at, q)
		}
	}
	src = []rune(insertBackslashes(src, at))
	// Pass 3: /^( {0,3})([=-])(?=[=-]*\s*$)/gm
	at = nil
	for _, start := range lineStarts(src) {
		p := start + spacesAt(src, start)
		if p >= len(src) || (src[p] != '=' && src[p] != '-') {
			continue
		}
		q := p + 1
		for q < len(src) && (src[q] == '=' || src[q] == '-') {
			q++
		}
		ok := false
		for k := q; ; k++ {
			if atLineEnd(src, k) {
				ok = true
				break
			}
			if !isJSSpace(src[k]) {
				break
			}
		}
		if ok {
			at = append(at, p)
		}
	}
	return insertBackslashes(src, at)
}

func codeSpan(text string) string {
	longest := 0
	cur := 0
	for _, r := range text {
		if r == '`' {
			cur++
			if cur > longest {
				longest = cur
			}
		} else {
			cur = 0
		}
	}
	fence := strings.Repeat("`", longest+1)
	if strings.HasPrefix(text, "`") || strings.HasSuffix(text, "`") {
		return fence + " " + text + " " + fence
	}
	return fence + text + fence
}

func hardBreaks(s string) string { return strings.ReplaceAll(s, "\n", "  \n") }

func parens(url string) string {
	return strings.ReplaceAll(strings.ReplaceAll(url, "(", "%28"), ")", "%29")
}

// RunsToMarkdown serializes runs. Underline and highlight have no markdown form and are dropped.
func RunsToMarkdown(input []Run) string {
	var out strings.Builder
	for _, r := range NormalizeRuns(input) {
		if r.Text != "" {
			core := jsTrim(r.Text)
			lead, trail := "", ""
			if core != "" {
				lead = r.Text[:len(r.Text)-len(jsTrimLeft(r.Text))]
				trail = r.Text[len(jsTrimRight(r.Text)):]
			} else {
				lead = r.Text
			}
			var inner string
			if r.Code {
				inner = codeSpan(core)
			} else {
				inner = hardBreaks(EscapeInline(core))
			}
			if core != "" {
				if r.Strike {
					inner = "~~" + inner + "~~"
				}
				switch {
				case r.Bold && r.Italic:
					inner = "***" + inner + "***"
				case r.Bold:
					inner = "**" + inner + "**"
				case r.Italic:
					inner = "*" + inner + "*"
				}
				if r.Href != "" {
					inner = "[" + inner + "](" + parens(r.Href) + ")"
				}
			}
			out.WriteString(hardBreaks(lead) + inner + hardBreaks(trail))
		}
		if r.HasCitation {
			out.WriteString("[^" + r.CitationID + "]")
		}
	}
	return out.String()
}

// InlineToPlain is the plain text of a markdown-lite string, for list items and table cells that hold plain
// strings. Link targets are kept in parentheses.
func InlineToPlain(markdown string) string {
	var out strings.Builder
	for _, r := range ParseInline(markdown) {
		if r.Href != "" && r.Text != r.Href {
			out.WriteString(r.Text + " (" + r.Href + ")")
		} else {
			out.WriteString(r.Text)
		}
	}
	return out.String()
}

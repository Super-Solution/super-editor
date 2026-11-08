// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package render

import (
	"fmt"
	"strings"

	"github.com/Super-Solution/super-editor/backends/go/validation"
)

// FromMarkdownOptions configure FromMarkdown.
type FromMarkdownOptions struct {
	// IDPrefix: block IDs are <IDPrefix>-1, <IDPrefix>-2, ... in document order.
	IDPrefix string
	// ParentID is the container that receives every block ("" means the top level).
	ParentID string
	// NoCitationMarkers keeps [^id] as text instead of reading it as an inline citation marker.
	NoCitationMarkers bool
}

// The line-level patterns of the reference are regular expressions with backtracking; they are matched by hand here.

func leadingSpaces(s []rune) int {
	n := 0
	for n < 3 && n < len(s) && s[n] == ' ' {
		n++
	}
	return n
}

// matchFence matches /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/ and returns the fence run and the info word.
func matchFence(line string) (marker, info string, ok bool) {
	s := []rune(line)
	i := leadingSpaces(s)
	if i >= len(s) || (s[i] != '`' && s[i] != '~') {
		return "", "", false
	}
	c := s[i]
	j := i
	for j < len(s) && s[j] == c {
		j++
	}
	if j-i < 3 {
		return "", "", false
	}
	for _, r := range s[j:] {
		if r == '`' {
			return "", "", false
		}
	}
	k := j
	for k < len(s) && isJSSpace(s[k]) {
		k++
	}
	e := k
	for e < len(s) && !isJSSpace(s[e]) {
		e++
	}
	return string(s[i:j]), string(s[k:e]), true
}

// matchHeading matches /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/ and returns the hash count and the text.
func matchHeading(line string) (level int, text string, ok bool) {
	s := []rune(line)
	i := leadingSpaces(s)
	j := i
	for j < len(s) && s[j] == '#' {
		j++
	}
	if j == i || j-i > 6 {
		return 0, "", false
	}
	rest := s[j:]
	if len(rest) == 0 {
		return j - i, "", true
	}
	if !isJSSpace(rest[0]) {
		return 0, "", false
	}
	k := 0
	for k < len(rest) && isJSSpace(rest[k]) {
		k++
	}
	body := rest[k:]
	end := len(body)
	for end > 0 && isJSSpace(body[end-1]) {
		end--
	}
	trimmed := body[:end]
	// An optional closing run of hashes, set off by whitespace, is not part of the text.
	h := len(trimmed)
	for h > 0 && trimmed[h-1] == '#' {
		h--
	}
	if h < len(trimmed) && h > 0 && isJSSpace(trimmed[h-1]) {
		e := h
		for e > 0 && isJSSpace(trimmed[e-1]) {
			e--
		}
		return j - i, string(trimmed[:e]), true
	}
	return j - i, string(trimmed), true
}

// matchBreak matches /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/ and returns the character.
func matchBreak(line string) (rune, bool) {
	s := []rune(line)
	i := leadingSpaces(s)
	if i >= len(s) || (s[i] != '-' && s[i] != '*' && s[i] != '_') {
		return 0, false
	}
	c := s[i]
	count := 0
	for _, r := range s[i:] {
		switch r {
		case c:
			count++
		case ' ', '\t':
		default:
			return 0, false
		}
	}
	return c, count >= 3
}

type item struct {
	spaces int
	marker string
	text   string
}

// matchItem matches /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/.
func matchItem(line string) (item, bool) {
	s := []rune(line)
	i := 0
	for i < len(s) && s[i] == ' ' {
		i++
	}
	if i >= len(s) {
		return item{}, false
	}
	j := i
	switch {
	case s[i] == '-' || s[i] == '*' || s[i] == '+':
		j = i + 1
	case s[i] >= '0' && s[i] <= '9':
		for j < len(s) && s[j] >= '0' && s[j] <= '9' {
			j++
		}
		if j-i > 9 || j >= len(s) || (s[j] != '.' && s[j] != ')') {
			return item{}, false
		}
		j++
	default:
		return item{}, false
	}
	if j >= len(s) || !isJSSpace(s[j]) {
		return item{}, false
	}
	k := j
	for k < len(s) && isJSSpace(s[k]) {
		k++
	}
	return item{spaces: i, marker: string(s[i:j]), text: string(s[k:])}, true
}

func isTableRule(line string) bool {
	s := []rune(strings.TrimLeftFunc(line, isJSSpace))
	if len(s) > 0 && s[0] == '|' {
		s = s[1:]
	}
	parts := strings.Split(string(s), "|")
	for i, p := range parts {
		p = jsTrim(p)
		if p == "" && i == len(parts)-1 && i > 0 {
			continue
		}
		if !isDashCell(p) {
			return false
		}
	}
	return true
}

func isDashCell(p string) bool {
	p = strings.TrimPrefix(p, ":")
	p = strings.TrimSuffix(p, ":")
	return p != "" && strings.Trim(p, "-") == ""
}

// matchImage matches /^!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)\s*$/.
func matchImage(line string) (alt, url string, ok bool) {
	s := []rune(line)
	if len(s) < 2 || s[0] != '!' || s[1] != '[' {
		return "", "", false
	}
	i := 2
	for i < len(s) && s[i] != ']' {
		i++
	}
	if i+1 >= len(s) || s[i+1] != '(' {
		return "", "", false
	}
	alt = string(s[2:i])
	start := i + 2
	try := func(from int) (string, bool) {
		j := from
		for j < len(s) && s[j] != ')' && s[j] != '>' && !isJSSpace(s[j]) {
			j++
		}
		if j == from {
			return "", false
		}
		target := string(s[from:j])
		if j < len(s) && s[j] == '>' {
			j++
		}
		if j < len(s) && isJSSpace(s[j]) {
			k := j
			for k < len(s) && isJSSpace(s[k]) {
				k++
			}
			if k < len(s) && s[k] == '"' {
				e := k + 1
				for e < len(s) && s[e] != '"' {
					e++
				}
				if e < len(s) {
					j = e + 1
				}
			}
		}
		if j >= len(s) || s[j] != ')' {
			return "", false
		}
		for _, r := range s[j+1:] {
			if !isJSSpace(r) {
				return "", false
			}
		}
		return target, true
	}
	if start < len(s) && s[start] == '<' {
		if u, ok := try(start + 1); ok {
			return alt, u, true
		}
	}
	if u, ok := try(start); ok {
		return alt, u, true
	}
	return "", "", false
}

func matchFootnoteDefinition(line string) bool {
	if !strings.HasPrefix(line, "[^") {
		return false
	}
	s := []rune(line[2:])
	i := 0
	for i < len(s) && s[i] != ']' {
		i++
	}
	return i > 0 && i+2 < len(s) && s[i] == ']' && s[i+1] == ':' && isJSSpace(s[i+2])
}

// startsBlock reports whether a line starts a new block and so ends the paragraph or list item before it.
func startsBlock(text string, next *string) bool {
	if _, _, ok := matchFence(text); ok {
		return true
	}
	s := []rune(text)
	i := leadingSpaces(s)
	if i < len(s) && s[i] == '#' {
		j := i
		for j < len(s) && s[j] == '#' {
			j++
		}
		if j-i <= 6 && (j >= len(s) || isJSSpace(s[j])) {
			return true
		}
	}
	if i < len(s) && s[i] == '>' {
		return true
	}
	if _, ok := matchBreak(text); ok {
		return true
	}
	if i+1 < len(s) {
		c := s[i]
		if (c == '-' || c == '*' || c == '+') && isJSSpace(s[i+1]) {
			return true
		}
		if c == '1' && i+2 < len(s) && (s[i+1] == '.' || s[i+1] == ')') && isJSSpace(s[i+2]) {
			return true
		}
	}
	if _, _, ok := matchImage(jsTrim(text)); ok {
		return true
	}
	return strings.Contains(text, "|") && next != nil && isTableRule(*next) && strings.Contains(*next, "|")
}

func splitRow(row string) []string {
	var cells []string
	var current []rune
	rs := []rune(row)
	for i := 0; i < len(rs); i++ {
		switch {
		case rs[i] == '\\' && i+1 < len(rs) && rs[i+1] == '|':
			current = append(current, '|')
			i++
		case rs[i] == '|':
			cells = append(cells, string(current))
			current = nil
		default:
			current = append(current, rs[i])
		}
	}
	cells = append(cells, string(current))
	if len(cells) > 0 && jsTrim(cells[0]) == "" {
		cells = cells[1:]
	}
	if len(cells) > 0 && jsTrim(cells[len(cells)-1]) == "" {
		cells = cells[:len(cells)-1]
	}
	for i := range cells {
		cells[i] = jsTrim(cells[i])
	}
	return cells
}

var tones = map[string]string{"NOTE": "info", "TIP": "success", "IMPORTANT": "note", "WARNING": "warning", "CAUTION": "danger", "INFO": "info", "SUCCESS": "success", "DANGER": "danger"}

func validPrefix(p string) bool {
	if len(p) == 0 || len(p) > 100 {
		return false
	}
	for i, r := range p {
		ok := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9'
		if i > 0 {
			ok = ok || r == '.' || r == '_' || r == ':' || r == '-'
		}
		if !ok {
			return false
		}
	}
	return true
}

func isTOC(line string) bool {
	s := strings.ToLower(jsTrim(line))
	return s == "[toc]" || s == "[[toc]]" || s == "[[toc]" || s == "[toc]]"
}

// splitParagraphs is `rows.join('\n').split(/\n\s*\n/)` with every piece trimmed per line, joined by spaces and non-empty.
func splitParagraphs(rows []string) []string {
	text := []rune(strings.Join(rows, "\n"))
	var pieces []string
	start := 0
	for i := 0; i < len(text); {
		if text[i] != '\n' {
			i++
			continue
		}
		last := -1
		for k := i + 1; k < len(text) && isJSSpace(text[k]); k++ {
			if text[k] == '\n' {
				last = k
			}
		}
		if last < 0 {
			i++
			continue
		}
		pieces = append(pieces, string(text[start:i]))
		start = last + 1
		i = last + 1
	}
	pieces = append(pieces, string(text[start:]))
	var out []string
	for _, piece := range pieces {
		lines := strings.Split(piece, "\n")
		for i := range lines {
			lines[i] = jsTrim(lines[i])
		}
		if joined := jsTrim(strings.Join(lines, " ")); joined != "" {
			out = append(out, joined)
		}
	}
	return out
}

// FromMarkdown converts block-level markdown to blocks (ATX headings, paragraphs, bullet, numbered and task lists with
// nesting, GFM tables, fenced code, block quotes and GitHub alerts, dividers, page breaks, [TOC], https image lines).
// It returns an error when the ID prefix is not usable.
func FromMarkdown(markdown string, o FromMarkdownOptions) ([]record, error) {
	if !validPrefix(o.IDPrefix) {
		return nil, fmt.Errorf(`fromMarkdown requires an idPrefix that starts with a letter or digit and uses only letters, digits, ".", "_", ":" or "-" (at most 100 characters)`)
	}
	var parent any
	if o.ParentID != "" {
		parent = o.ParentID
	}
	normalized := strings.ReplaceAll(strings.ReplaceAll(markdown, "\r\n", "\n"), "\r", "\n")
	lines := strings.Split(normalized, "\n")
	result := []record{}
	emit := func(content record) {
		result = append(result, record{"id": fmt.Sprintf("%s-%d", o.IDPrefix, len(result)+1), "parentId": parent, "content": content, "citationIds": []any{}})
	}
	inline := func(text string) []any {
		parsed := ParseInline(text)
		if o.NoCitationMarkers {
			for i, r := range parsed {
				if r.HasCitation && r.Text == "" {
					parsed[i] = Run{Text: "[^" + r.CitationID + "]"}
				}
			}
			parsed = NormalizeRuns(parsed)
		}
		return RunsToAny(parsed)
	}
	next := func(i int) *string {
		if i+1 < len(lines) {
			return &lines[i+1]
		}
		return nil
	}
	index := 0
	for index < len(lines) {
		text := lines[index]
		if jsTrim(text) == "" {
			index++
			continue
		}
		if marker, info, ok := matchFence(text); ok {
			var body []string
			index++
			for index < len(lines) && !closesFence(lines[index], marker) {
				body = append(body, lines[index])
				index++
			}
			index++
			language := ""
			if isLanguage(info) {
				language = sliceChars(info, 40)
			}
			emit(record{"type": "code", "language": language, "text": strings.Join(body, "\n")})
			continue
		}
		if level, heading, ok := matchHeading(text); ok {
			emit(record{"type": "heading", "level": float64(min(3, level)), "text": InlineToPlain(heading)})
			index++
			continue
		}
		if c, ok := matchBreak(text); ok {
			kind := "divider"
			if c == '*' {
				kind = "pageBreak"
			}
			emit(record{"type": kind})
			index++
			continue
		}
		if isTOC(text) {
			emit(record{"type": "toc"})
			index++
			continue
		}
		if alt, url, ok := matchImage(jsTrim(text)); ok && startsWithBang(text) {
			if safe, ok := validation.SafeURL(url, true); ok {
				emit(record{"type": "image", "url": safe, "alt": alt})
				index++
				continue
			}
		}
		if isQuoteLine(text) {
			var inner []string
			for index < len(lines) && isQuoteLine(lines[index]) {
				inner = append(inner, stripQuote(lines[index]))
				index++
			}
			if emitQuote(inner, inline, emit) {
				continue
			}
		}
		if first, ok := matchItem(text); ok {
			index = parseList(lines, index, first, emit)
			continue
		}
		if strings.Contains(text, "|") && index+1 < len(lines) && isTableRule(lines[index+1]) && strings.Contains(lines[index+1], "|") {
			columns := mapStrings(splitRow(text), InlineToPlain)
			rule := splitRow(lines[index+1])
			alignment := make([]string, len(rule))
			anyAlign := false
			for i, cell := range rule {
				switch {
				case len(cell) > 2 && strings.HasPrefix(cell, ":") && strings.HasSuffix(cell, ":") && strings.Trim(cell[1:len(cell)-1], "-") == "":
					alignment[i] = "center"
				case strings.HasSuffix(cell, "-:"):
					alignment[i] = "right"
				case strings.HasPrefix(cell, ":-"):
					alignment[i] = "left"
				}
				if alignment[i] != "" {
					anyAlign = true
				}
			}
			var rows []any
			index += 2
			for index < len(lines) && jsTrim(lines[index]) != "" && strings.Contains(lines[index], "|") {
				cells := mapStrings(splitRow(lines[index]), InlineToPlain)
				index++
				row := make([]any, len(columns))
				for c := range columns {
					if c < len(cells) {
						row[c] = cells[c]
					} else {
						row[c] = ""
					}
				}
				rows = append(rows, row)
			}
			content := record{"type": "table", "columns": anyStrings(columns), "rows": nonNil(rows)}
			if anyAlign {
				align := make([]any, len(columns))
				for c := range columns {
					if c < len(alignment) && alignment[c] != "" {
						align[c] = alignment[c]
					} else {
						align[c] = "left"
					}
				}
				content["align"] = align
			}
			emit(content)
			continue
		}
		var body []string
		for index < len(lines) && jsTrim(lines[index]) != "" && (len(body) == 0 || !startsBlock(lines[index], next(index))) {
			body = append(body, lines[index])
			index++
		}
		var joined strings.Builder
		for position, row := range body {
			last := position == len(body)-1
			trimmed := jsTrimLeft(row)
			switch {
			case !last && strings.HasSuffix(row, "\\"):
				joined.WriteString(strings.TrimSuffix(trimmed, "\\") + "\n")
			case !last && strings.HasSuffix(row, "  "):
				joined.WriteString(strings.TrimRight(trimmed, " ") + "\n")
			case last:
				joined.WriteString(jsTrimRight(trimmed))
			default:
				joined.WriteString(jsTrimRight(trimmed) + " ")
			}
		}
		text2 := joined.String()
		if matchFootnoteDefinition(body[0]) {
			emit(record{"type": "paragraph", "runs": RunsToAny(PlainRuns(text2))})
		} else if jsTrim(text2) != "" {
			emit(record{"type": "paragraph", "runs": inline(text2)})
		}
	}
	return result, nil
}

func nonNil(v []any) []any {
	if v == nil {
		return []any{}
	}
	return v
}

func startsWithBang(text string) bool {
	s := []rune(text)
	i := leadingSpaces(s)
	return i < len(s) && s[i] == '!'
}

func isLanguage(info string) bool {
	for _, r := range info {
		ok := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("+#._-", r)
		if !ok {
			return false
		}
	}
	return true
}

func closesFence(line, marker string) bool {
	s := []rune(line)
	i := leadingSpaces(s)
	c := []rune(marker)[0]
	j := i
	for j < len(s) && s[j] == c {
		j++
	}
	if j-i < len([]rune(marker)) {
		return false
	}
	for _, r := range s[j:] {
		if !isJSSpace(r) {
			return false
		}
	}
	return true
}

func isQuoteLine(line string) bool {
	s := []rune(line)
	i := leadingSpaces(s)
	return i < len(s) && s[i] == '>'
}

func stripQuote(line string) string {
	s := []rune(line)
	i := leadingSpaces(s) + 1
	if i < len(s) && s[i] == ' ' {
		i++
	}
	return string(s[i:])
}

func isAlertLine(s string) (string, bool) {
	t := jsTrimRight(s)
	if !strings.HasPrefix(t, "[!") || !strings.HasSuffix(t, "]") {
		return "", false
	}
	name := t[2 : len(t)-1]
	if name == "" {
		return "", false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			return "", false
		}
	}
	return name, true
}

func boldTitle(s string) (string, bool) {
	t := jsTrimRight(s)
	if !strings.HasPrefix(t, "**") || !strings.HasSuffix(t, "**") || len(t) < 5 {
		return "", false
	}
	inner := t[2 : len(t)-2]
	if inner == "" || strings.Contains(inner, "*") {
		return "", false
	}
	return inner, true
}

// attributionOf matches /^(?:—|--)\s+(.+)$/.
func attributionOf(s string) (string, bool) {
	var rest string
	switch {
	case strings.HasPrefix(s, "—"):
		rest = strings.TrimPrefix(s, "—")
	case strings.HasPrefix(s, "--"):
		rest = strings.TrimPrefix(s, "--")
	default:
		return "", false
	}
	trimmed := jsTrimLeft(rest)
	if len(trimmed) == len(rest) {
		return "", false
	}
	if trimmed == "" {
		// \s+ gives one whitespace character back to (.+)
		if r := []rune(rest); len(r) >= 2 {
			return string(r[len(r)-1:]), true
		}
		return "", false
	}
	return trimmed, true
}

func emitQuote(inner []string, inline func(string) []any, emit func(record)) bool {
	first := ""
	if len(inner) > 0 {
		first = inner[0]
	}
	if name, ok := isAlertLine(first); ok {
		if tone, known := tones[strings.ToUpper(name)]; known {
			skip := 1
			content := record{"type": "callout", "tone": tone}
			if len(inner) > 1 {
				if title, ok := boldTitle(inner[1]); ok {
					content["title"] = title
					skip = 2
				}
			}
			body := splitParagraphs(inner[skip:])
			content["runs"] = inline(strings.Join(body, "\n\n"))
			emit(content)
			return true
		}
	}
	body := splitParagraphs(inner)
	content := record{"type": "quote"}
	if len(body) > 0 {
		if attribution, ok := attributionOf(body[len(body)-1]); ok {
			body = body[:len(body)-1]
			content["attribution"] = InlineToPlain(attribution)
		}
	}
	content["runs"] = inline(strings.Join(body, "\n\n"))
	emit(content)
	return true
}

func isDigit(r byte) bool { return r >= '0' && r <= '9' }

func hasCheckbox(text string) (checked bool, rest string, ok bool) {
	// /^\[([ xX])\]\s+(.*)$/
	if len(text) < 4 || text[0] != '[' || text[2] != ']' || (text[1] != ' ' && text[1] != 'x' && text[1] != 'X') {
		return false, "", false
	}
	after := []rune(text[3:])
	if len(after) == 0 || !isJSSpace(after[0]) {
		return false, "", false
	}
	k := 0
	for k < len(after) && isJSSpace(after[k]) {
		k++
	}
	return text[1] != ' ', string(after[k:]), true
}

func isTodoStart(text string) bool {
	// /^\[[ xX]\]\s/
	if len(text) < 4 || text[0] != '[' || text[2] != ']' || (text[1] != ' ' && text[1] != 'x' && text[1] != 'X') {
		return false
	}
	r := []rune(text[3:])
	return len(r) > 0 && isJSSpace(r[0])
}

func parseList(lines []string, index int, first item, emit func(record)) int {
	var items, checkedList, levels []any
	var stack []int
	ordered := isDigit(first.marker[0])
	todo := isTodoStart(first.text)
	for index < len(lines) {
		current := lines[index]
		if jsTrim(current) == "" {
			next := index + 1
			for next < len(lines) && jsTrim(lines[next]) == "" {
				next++
			}
			if next < len(lines) {
				if upcoming, ok := matchItem(lines[next]); ok {
					if _, isBreak := matchBreak(lines[next]); !isBreak && (upcoming.spaces > 0 || isDigit(upcoming.marker[0]) == ordered) {
						index = next
						continue
					}
				}
			}
			break
		}
		if it, ok := matchItem(current); ok {
			if _, isBreak := matchBreak(current); !isBreak {
				if it.spaces == 0 && isDigit(it.marker[0]) != ordered && len(items) > 0 {
					break
				}
				for len(stack) > 1 && it.spaces < stack[len(stack)-1] {
					stack = stack[:len(stack)-1]
				}
				if len(stack) == 0 || it.spaces > stack[len(stack)-1] {
					stack = append(stack, it.spaces)
				}
				checked, rest, box := false, "", false
				if todo {
					checked, rest, box = hasCheckbox(it.text)
				}
				levels = append(levels, float64(min(3, len(stack)-1)))
				checkedList = append(checkedList, box && checked)
				if box {
					items = append(items, InlineToPlain(rest))
				} else {
					items = append(items, InlineToPlain(it.text))
				}
				index++
				continue
			}
		}
		// Anything that does not start a new block continues the previous item (indented or lazy).
		var next *string
		if index+1 < len(lines) {
			next = &lines[index+1]
		}
		if len(items) > 0 && !startsBlock(current, next) {
			items[len(items)-1] = items[len(items)-1].(string) + " " + InlineToPlain(jsTrim(current))
			index++
			continue
		}
		break
	}
	indented := false
	for _, l := range levels {
		if l.(float64) > 0 {
			indented = true
		}
	}
	content := record{"type": "list", "ordered": ordered && !todo, "items": nonNil(items)}
	if todo {
		content["style"] = "todo"
		content["checked"] = nonNil(checkedList)
	}
	if indented {
		content["indent"] = levels
	}
	emit(content)
	return index
}

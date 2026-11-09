// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package render

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// jsNumber formats a number the way JavaScript's String(number) does.
func jsNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	sign := ""
	if f < 0 {
		sign, f = "-", -f
	}
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddde±XX, shortest digits that round-trip
	mant, expText, _ := strings.Cut(e, "e")
	exp, _ := strconv.Atoi(expText)
	digits := strings.Replace(mant, ".", "", 1)
	k, n := len(digits), exp+1 // value = 0.digits × 10^n
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	expo := n - 1
	signChar := "+"
	if expo < 0 {
		signChar, expo = "-", -expo
	}
	if k == 1 {
		return sign + digits + "e" + signChar + strconv.Itoa(expo)
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + signChar + strconv.Itoa(expo)
}

func num(v any) string {
	switch t := v.(type) {
	case float64:
		return jsNumber(t)
	case int:
		return strconv.Itoa(t)
	}
	return ""
}

func str(m record, key string) string { s, _ := m[key].(string); return s }

func has(m record, key string) bool { _, ok := m[key]; return ok }

func list(v any) []any { l, _ := v.([]any); return l }

func strList(v any) []string {
	l := list(v)
	out := make([]string, len(l))
	for i, s := range l {
		out[i], _ = s.(string)
	}
	return out
}

func rec(v any) record { m, _ := v.(record); return m }

type tree struct {
	doc      record
	children map[string][]record
	numbers  map[string]int
}

func newTree(doc record) *tree {
	t := &tree{doc: doc, children: childIndex(blocksOf(doc)), numbers: map[string]int{}}
	for i, c := range list(doc["citations"]) {
		t.numbers[str(rec(c), "id")] = i + 1
	}
	return t
}

// line collapses every whitespace run that holds a newline into one space, then trims.
func line(text string) string {
	rs := []rune(text)
	var out strings.Builder
	for i := 0; i < len(rs); {
		if !isJSSpace(rs[i]) {
			out.WriteRune(rs[i])
			i++
			continue
		}
		j := i
		newline := false
		for j < len(rs) && isJSSpace(rs[j]) {
			if rs[j] == '\n' {
				newline = true
			}
			j++
		}
		if newline {
			out.WriteByte(' ')
		} else {
			out.WriteString(string(rs[i:j]))
		}
		i = j
	}
	return jsTrim(out.String())
}

// blockSources are the block-level citations that are not already marked inline inside the same block.
func blockSources(b record) []string {
	inline := map[string]bool{}
	for _, r := range RunsOf(contentOf(b)) {
		if r.HasCitation {
			inline[r.CitationID] = true
		}
	}
	var out []string
	for _, id := range strList(b["citationIds"]) {
		if !inline[id] {
			out = append(out, id)
		}
	}
	return out
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	r := []rune(s)
	return strings.ToUpper(string(r[0])) + string(r[1:])
}

func percent(v any) string {
	f, _ := v.(float64)
	sign := ""
	if f > 0 {
		sign = "+"
	}
	return sign + num(v) + "%"
}

// ChartTable is the data table every non-visual export shows for a chart.
type ChartTable struct {
	Head    []string
	Rows    [][]string
	Omitted int
}

func valueAt(values []any, index int) string {
	if index < len(values) {
		return num(values[index])
	}
	return ""
}

func labelOr(v any, fallback string) string {
	if s, ok := v.(string); ok {
		return s
	}
	return fallback
}

// ChartData builds the table for a chart spec, limited to maxRows rows.
func ChartData(spec record, maxRows int) ChartTable {
	var head []string
	var rows [][]string
	kind := str(spec, "kind")
	ohlc := list(spec["ohlc"])
	points := list(spec["points"])
	series := list(spec["series"])
	switch {
	case kind == "candlestick" && len(ohlc) > 0:
		volume := false
		for _, c := range ohlc {
			if has(rec(c), "v") {
				volume = true
			}
		}
		head = []string{"Time", "Open", "High", "Low", "Close"}
		if volume {
			head = append(head, "Volume")
		}
		for _, item := range ohlc {
			c := rec(item)
			row := []string{str(c, "t"), num(c["o"]), num(c["h"]), num(c["l"]), num(c["c"])}
			if volume {
				if has(c, "v") {
					row = append(row, num(c["v"]))
				} else {
					row = append(row, "")
				}
			}
			rows = append(rows, row)
		}
	case kind == "scatter" && len(points) > 0:
		head = []string{"Series", labelOr(spec["xLabel"], "x"), labelOr(rec(spec["yAxis"])["label"], "y")}
		for _, item := range points {
			p := rec(item)
			rows = append(rows, []string{str(p, "series"), num(p["x"]), num(p["y"])})
		}
	case kind == "heatmap" && spec["matrix"] != nil:
		matrix := rec(spec["matrix"])
		head = append([]string{""}, strList(matrix["columns"])...)
		values := list(matrix["values"])
		for i, r := range strList(matrix["rows"]) {
			row := []string{r}
			if i < len(values) {
				for _, v := range list(values[i]) {
					row = append(row, num(v))
				}
			}
			rows = append(rows, row)
		}
	default:
		head = []string{labelOr(spec["xLabel"], "")}
		for _, s := range series {
			head = append(head, str(rec(s), "name"))
		}
		for i, label := range strList(spec["labels"]) {
			row := []string{label}
			for _, s := range series {
				row = append(row, valueAt(list(rec(s)["values"]), i))
			}
			rows = append(rows, row)
		}
	}
	omitted := 0
	if len(rows) > maxRows {
		omitted = len(rows) - maxRows
		rows = rows[:maxRows]
	}
	return ChartTable{Head: head, Rows: rows, Omitted: omitted}
}

func chartDescriptor(spec record) string {
	out := str(spec, "kind") + " chart"
	if u := str(spec, "unit"); u != "" {
		out += ", " + u
	}
	if a := str(spec, "asOf"); a != "" {
		out += ", as of " + a
	}
	return out
}

func sourceLine(spec record) string {
	if s := str(spec, "source"); s != "" {
		return "Source: " + s
	}
	return ""
}

func annotationLine(spec record) string {
	notes := list(spec["annotations"])
	if len(notes) == 0 {
		return ""
	}
	parts := make([]string, len(notes))
	for i, n := range notes {
		note := rec(n)
		value := ""
		if has(note, "value") {
			value = ", " + num(note["value"])
		}
		parts[i] = fmt.Sprintf("%s (%s%s)", str(note, "label"), str(note, "at"), value)
	}
	return "Notes: " + strings.Join(parts, "; ")
}

// ---- Markdown -----------------------------------------------------------------------------------------------------

// MarkdownOptions configure ToMarkdown.
type MarkdownOptions struct {
	NoTitle   bool
	ChartRows int // 0 means the default, 100
}

var alerts = map[string]string{"info": "NOTE", "success": "TIP", "note": "IMPORTANT", "warning": "WARNING", "danger": "CAUTION"}

func mdTable(head []string, rows [][]string, align []string) string {
	cell := func(text string) string { return strings.ReplaceAll(EscapeInline(line(text)), "|", "\\|") }
	rule := make([]string, len(head))
	for i := range head {
		a := ""
		if i < len(align) {
			a = align[i]
		}
		switch a {
		case "left":
			rule[i] = ":---"
		case "right":
			rule[i] = "---:"
		case "center":
			rule[i] = ":---:"
		default:
			rule[i] = "---"
		}
	}
	lines := []string{"| " + strings.Join(mapStrings(head, cell), " | ") + " |", "| " + strings.Join(rule, " | ") + " |"}
	for _, row := range rows {
		lines = append(lines, "| "+strings.Join(mapStrings(row, cell), " | ")+" |")
	}
	return strings.Join(lines, "\n")
}

func mapStrings(in []string, f func(string) string) []string {
	out := make([]string, len(in))
	for i, s := range in {
		out[i] = f(s)
	}
	return out
}

func fence(text, language string) string {
	longest, cur := 2, 0
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
	marks := strings.Repeat("`", longest+1)
	return marks + language + "\n" + text + "\n" + marks
}

func quoted(text string) string {
	rows := strings.Split(text, "\n")
	for i, row := range rows {
		if row != "" {
			rows[i] = "> " + row
		} else {
			rows[i] = ">"
		}
	}
	return strings.Join(rows, "\n")
}

func isOrdered(content record) bool {
	if style := str(content, "style"); style != "" {
		return style == "number"
	}
	b, _ := content["ordered"].(bool)
	return b
}

func indentAt(content record, i int) int {
	ind := list(content["indent"])
	if i < len(ind) {
		f, _ := ind[i].(float64)
		return int(f)
	}
	return 0
}

func checkedAt(content record, i int) bool {
	c := list(content["checked"])
	if i < len(c) {
		b, _ := c[i].(bool)
		return b
	}
	return false
}

func listMarkdown(content record) string {
	ordered := isOrdered(content)
	pad := "  "
	if ordered {
		pad = "   "
	}
	var counters []int
	var out []string
	for i, item := range strList(content["items"]) {
		level := indentAt(content, i)
		for len(counters) < level+1 {
			counters = append(counters, 0)
		}
		counters = counters[:level+1]
		counters[level]++
		marker := "- "
		switch {
		case str(content, "style") == "todo":
			box := " "
			if checkedAt(content, i) {
				box = "x"
			}
			marker = "- [" + box + "] "
		case ordered:
			marker = strconv.Itoa(counters[level]) + ". "
		}
		out = append(out, strings.Repeat(pad, level)+marker+EscapeLineStarts(EscapeInline(line(item))))
	}
	return strings.Join(out, "\n")
}

func outlineMarkdown(items []*OutlineItem, depth int) []string {
	var out []string
	for _, item := range items {
		out = append(out, strings.Repeat("  ", depth)+"- "+EscapeLineStarts(EscapeInline(line(item.Title))))
		out = append(out, outlineMarkdown(item.Children, depth+1)...)
	}
	return out
}

func chartRows(n int, fallback int) int {
	if n == 0 {
		return fallback
	}
	return n
}

// ToMarkdown renders a document as Markdown for reading and exchange. Charts become data tables, callouts GitHub
// alerts, citations footnotes. Underline, highlight, image and embed sizing and the open state of toggles are dropped.
func ToMarkdown(doc record, o MarkdownOptions) string {
	t := newTree(doc)
	rows := chartRows(o.ChartRows, 100)
	var parts []string
	if title := str(doc, "title"); !o.NoTitle && title != "" {
		parts = append(parts, "# "+EscapeHeadingText(line(title)))
	}
	var render func(b record, depth int)
	render = func(b record, depth int) {
		c := contentOf(b)
		switch c["type"] {
		case "section":
			parts = append(parts, strings.Repeat("#", min(6, 2+depth))+" "+EscapeHeadingText(line(str(c, "title"))))
		case "toggle":
			parts = append(parts, "**"+EscapeInline(line(str(c, "title")))+"**")
		case "heading":
			level, _ := c["level"].(float64)
			parts = append(parts, strings.Repeat("#", min(6, int(level)+depth))+" "+EscapeHeadingText(line(str(c, "text"))))
		case "paragraph":
			text := EscapeLineStarts(RunsToMarkdown(RunsOf(c)))
			if jsTrim(text) != "" {
				parts = append(parts, text)
			}
		case "list":
			parts = append(parts, listMarkdown(c))
		case "table":
			parts = append(parts, mdTable(strList(c["columns"]), tableRows(c), strList(c["align"])))
			if caption := str(c, "caption"); caption != "" {
				parts = append(parts, "*"+EscapeInline(line(caption))+"*")
			}
		case "chart":
			spec := rec(c["spec"])
			data := ChartData(spec, rows)
			parts = append(parts, "**"+EscapeInline(line(str(spec, "title")))+"** ("+chartDescriptor(spec)+")", mdTable(data.Head, data.Rows, nil))
			if data.Omitted > 0 {
				parts = append(parts, fmt.Sprintf("*… %d more rows omitted*", data.Omitted))
			}
			for _, extra := range []string{annotationLine(spec), str(spec, "caption"), sourceLine(spec)} {
				if extra != "" {
					parts = append(parts, EscapeLineStarts(EscapeInline(line(extra))))
				}
			}
		case "embed":
			parts = append(parts, "["+EscapeInline(line(str(c, "title")))+"]("+parens(str(c, "url"))+")")
		case "timestamp":
			parts = append(parts, EscapeLineStarts(EscapeInline(line(str(c, "label")))+": "+str(c, "at")))
		case "quote":
			body := EscapeLineStarts(RunsToMarkdown(RunsOf(c)))
			if attribution := str(c, "attribution"); attribution != "" {
				body += "\n\n— " + EscapeInline(line(attribution))
			}
			parts = append(parts, quoted(body))
		case "callout":
			body := EscapeLineStarts(RunsToMarkdown(RunsOf(c)))
			title := ""
			if s := str(c, "title"); s != "" {
				title = "**" + EscapeInline(line(s)) + "**\n"
			}
			parts = append(parts, quoted("[!"+alerts[str(c, "tone")]+"]\n"+title+body))
		case "code":
			parts = append(parts, fence(str(c, "text"), str(c, "language")))
		case "divider":
			parts = append(parts, "---")
		case "pageBreak":
			parts = append(parts, "***")
		case "image":
			parts = append(parts, "!["+EscapeInline(line(str(c, "alt")))+"]("+parens(str(c, "url"))+")")
			if caption := str(c, "caption"); caption != "" {
				parts = append(parts, "*"+EscapeInline(line(caption))+"*")
			}
		case "metrics":
			items := list(c["items"])
			change, hint := false, false
			for _, it := range items {
				m := rec(it)
				if has(m, "change") {
					change = true
				}
				if str(m, "hint") != "" {
					hint = true
				}
			}
			head := []string{"Metric", "Value"}
			if change {
				head = append(head, "Change")
			}
			if hint {
				head = append(head, "Note")
			}
			var body [][]string
			for _, it := range items {
				m := rec(it)
				row := []string{str(m, "label"), str(m, "value")}
				if change {
					if has(m, "change") {
						row = append(row, percent(m["change"]))
					} else {
						row = append(row, "")
					}
				}
				if hint {
					row = append(row, str(m, "hint"))
				}
				body = append(body, row)
			}
			parts = append(parts, mdTable(head, body, nil))
		case "toc":
			if outline := outlineMarkdown(Outline(doc), 0); len(outline) > 0 {
				parts = append(parts, strings.Join(outline, "\n"))
			}
		}
		if sources := blockSources(b); len(sources) > 0 {
			refs := make([]string, len(sources))
			for i, id := range sources {
				refs[i] = "[^" + id + "]"
			}
			parts = append(parts, "Sources: "+strings.Join(refs, " "))
		}
		next := depth
		if c["type"] == "section" {
			next = depth + 1
		}
		for _, child := range t.children[idOf(b)] {
			render(child, next)
		}
	}
	for _, b := range t.children[""] {
		render(b, 0)
	}
	if citations := list(doc["citations"]); len(citations) > 0 {
		lines := make([]string, len(citations))
		for i, ci := range citations {
			c := rec(ci)
			s := "[^" + str(c, "id") + "]: [" + EscapeInline(line(str(c, "title"))) + "](" + parens(str(c, "url")) + "), accessed " + sliceChars(str(c, "accessedAt"), 10)
			if p := str(c, "publishedAt"); p != "" {
				s += ", published " + sliceChars(p, 10)
			}
			lines[i] = s
		}
		parts = append(parts, strings.Join(lines, "\n"))
	}
	return strings.Join(parts, "\n\n") + "\n"
}

func sliceChars(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func tableRows(c record) [][]string {
	rows := list(c["rows"])
	out := make([][]string, len(rows))
	for i, r := range rows {
		out[i] = strList(r)
	}
	return out
}

func anyStrings(items []string) []any {
	out := make([]any, len(items))
	for i, s := range items {
		out[i] = s
	}
	return out
}

// JSNumber formats a number the way JavaScript's String(number) does.
func JSNumber(f float64) string { return jsNumber(f) }

// Line collapses every whitespace run that holds a newline into one space, then trims (the exporters' one-line form).
func Line(text string) string { return line(text) }

// JSLower is String.prototype.toLowerCase.
func JSLower(s string) string { return jsLower(s) }

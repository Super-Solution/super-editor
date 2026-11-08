// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package render

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode"

	"github.com/Super-Solution/super-editor/backends/go/documents"
)

// TextOptions configure ToPlainText.
type TextOptions struct {
	NoTitle   bool
	ChartRows int // 0 means the default, 20
}

// ToPlainText renders readable text without markup: lists keep their markers, tables become tab-separated rows,
// charts a short data listing.
func ToPlainText(doc record, o TextOptions) string {
	t := newTree(doc)
	rows := chartRows(o.ChartRows, 20)
	var parts []string
	citationLabel := func(id string) string {
		if n, ok := t.numbers[id]; ok {
			return strconv.Itoa(n)
		}
		return id
	}
	withMarkers := func(runs []Run) string {
		var b strings.Builder
		for _, r := range runs {
			b.WriteString(r.Text)
			if r.HasCitation {
				b.WriteString("[" + citationLabel(r.CitationID) + "]")
			}
		}
		return b.String()
	}
	var walk func(items []*OutlineItem, depth int) []string
	walk = func(items []*OutlineItem, depth int) []string {
		var out []string
		for _, item := range items {
			out = append(out, strings.Repeat("  ", depth)+item.Title)
			out = append(out, walk(item.Children, depth+1)...)
		}
		return out
	}
	var render func(b record)
	render = func(b record) {
		c := contentOf(b)
		before := len(parts)
		switch c["type"] {
		case "section", "toggle":
			parts = append(parts, str(c, "title"))
		case "heading", "code":
			parts = append(parts, str(c, "text"))
		case "paragraph":
			parts = append(parts, withMarkers(RunsOf(c)))
		case "list":
			ordered := isOrdered(c)
			var counters []int
			var lines []string
			for i, item := range strList(c["items"]) {
				level := indentAt(c, i)
				for len(counters) < level+1 {
					counters = append(counters, 0)
				}
				counters = counters[:level+1]
				counters[level]++
				marker := "-"
				switch {
				case str(c, "style") == "todo":
					box := " "
					if checkedAt(c, i) {
						box = "x"
					}
					marker = "[" + box + "]"
				case ordered:
					marker = strconv.Itoa(counters[level]) + "."
				}
				lines = append(lines, strings.Repeat("  ", level)+marker+" "+item)
			}
			parts = append(parts, strings.Join(lines, "\n"))
		case "table":
			var lines []string
			if caption := str(c, "caption"); caption != "" {
				lines = append(lines, caption)
			}
			lines = append(lines, strings.Join(strList(c["columns"]), "\t"))
			for _, row := range tableRows(c) {
				lines = append(lines, strings.Join(row, "\t"))
			}
			parts = append(parts, strings.Join(lines, "\n"))
		case "chart":
			spec := rec(c["spec"])
			data := ChartData(spec, rows)
			lines := []string{str(spec, "title") + " (" + chartDescriptor(spec) + ")", strings.Join(data.Head, "\t")}
			for _, row := range data.Rows {
				lines = append(lines, strings.Join(row, "\t"))
			}
			if data.Omitted > 0 {
				lines = append(lines, fmt.Sprintf("… %d more rows", data.Omitted))
			}
			for _, extra := range []string{annotationLine(spec), str(spec, "caption"), sourceLine(spec)} {
				if extra != "" {
					lines = append(lines, extra)
				}
			}
			parts = append(parts, strings.Join(lines, "\n"))
		case "embed":
			parts = append(parts, str(c, "title")+" ("+str(c, "url")+")")
		case "timestamp":
			parts = append(parts, str(c, "label")+": "+str(c, "at"))
		case "quote":
			s := "“" + withMarkers(RunsOf(c)) + "”"
			if a := str(c, "attribution"); a != "" {
				s += " — " + a
			}
			parts = append(parts, s)
		case "callout":
			s := capitalize(str(c, "tone"))
			if title := str(c, "title"); title != "" {
				s += ": " + title
			}
			parts = append(parts, s+"\n"+withMarkers(RunsOf(c)))
		case "divider", "pageBreak":
			parts = append(parts, "----")
		case "image":
			label := str(c, "alt")
			if label == "" {
				label = str(c, "url")
			}
			s := "[Image: " + label + "]"
			if caption := str(c, "caption"); caption != "" {
				s += " " + caption
			}
			parts = append(parts, s)
		case "metrics":
			var lines []string
			for _, it := range list(c["items"]) {
				m := rec(it)
				s := str(m, "label") + ": " + str(m, "value")
				if has(m, "change") {
					s += " (" + percent(m["change"]) + ")"
				}
				if hint := str(m, "hint"); hint != "" {
					s += " — " + hint
				}
				lines = append(lines, s)
			}
			parts = append(parts, strings.Join(lines, "\n"))
		case "toc":
			if outline := walk(Outline(doc), 0); len(outline) > 0 {
				parts = append(parts, strings.Join(outline, "\n"))
			}
		}
		if extra := blockSources(b); len(extra) > 0 && len(parts) > before {
			labels := ""
			for _, id := range extra {
				labels += "[" + citationLabel(id) + "]"
			}
			parts[len(parts)-1] += " " + labels
		}
		for _, child := range t.children[idOf(b)] {
			render(child)
		}
	}
	if title := str(doc, "title"); !o.NoTitle && title != "" {
		parts = append(parts, title)
	}
	for _, b := range t.children[""] {
		render(b)
	}
	if citations := list(doc["citations"]); len(citations) > 0 {
		lines := []string{"Sources"}
		for i, ci := range citations {
			c := rec(ci)
			lines = append(lines, fmt.Sprintf("[%d] %s — %s (accessed %s)", i+1, str(c, "title"), str(c, "url"), sliceChars(str(c, "accessedAt"), 10)))
		}
		parts = append(parts, strings.Join(lines, "\n"))
	}
	var kept []string
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, "\n\n") + "\n"
}

// ---- statistics ------------------------------------------------------------------------------------------------------

func isCJK(r rune) bool {
	return unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r)
}

func isTokenChar(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) || unicode.IsMark(r) }

// CountWords counts words in one string: Latin-style tokens plus CJK characters.
func CountWords(text string) (latin, cjk int) {
	rs := []rune(text)
	for i, r := range rs {
		if isCJK(r) {
			cjk++
			rs[i] = ' '
		}
	}
	// /[\p{L}\p{N}\p{M}]+(?:['’.,-][\p{L}\p{N}\p{M}]+)*/gu
	for i := 0; i < len(rs); {
		if !isTokenChar(rs[i]) {
			i++
			continue
		}
		for i < len(rs) && isTokenChar(rs[i]) {
			i++
		}
		for i+1 < len(rs) && strings.ContainsRune("'’.,-", rs[i]) && isTokenChar(rs[i+1]) {
			i++
			for i < len(rs) && isTokenChar(rs[i]) {
				i++
			}
		}
		latin++
	}
	return latin, cjk
}

// Stats summarizes a document: words, characters, block counts, reading time.
func Stats(doc record) record {
	latin, cjk, characters, noSpaces := 0, 0, 0, 0
	byType := record{}
	blocks := blocksOf(doc)
	for _, b := range blocks {
		t := typeOf(b)
		n, _ := byType[t].(float64)
		byType[t] = n + 1
		for _, part := range documents.TextParts(contentOf(b)) {
			l, c := CountWords(part)
			latin += l
			cjk += c
			characters += len([]rune(part))
			noSpaces += len([]rune(strings.Map(func(r rune) rune {
				if isJSSpace(r) {
					return -1
				}
				return r
			}, part)))
		}
	}
	minutes := float64(latin)/220 + float64(cjk)/400
	reading := 0.0
	if minutes > 0 {
		reading = max(1, math.Ceil(minutes))
	}
	count := func(t string) float64 { n, _ := byType[t].(float64); return n }
	return record{"words": float64(latin + cjk), "characters": float64(characters), "charactersNoSpaces": float64(noSpaces), "blocks": float64(len(blocks)),
		"blocksByType": byType, "charts": count("chart"), "tables": count("table"), "images": count("image"),
		"citations": float64(len(list(doc["citations"]))), "readingMinutes": reading}
}

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package editor

import (
	"math"
	"unicode"
)

// replacer implements replaceText the way the reference does: a literal, case-insensitive (Unicode simple case
// folding) or case-sensitive search over code points, with a shared budget of replacements across all text
// fields of a block, taken in the order the reference visits them.
type replacer struct {
	pattern []rune
	replace string
	fold    bool
	budget  int
	count   int
}

func newReplacer(find, replace string, all, caseSensitive bool) *replacer {
	budget := 1
	if all {
		budget = math.MaxInt
	}
	return &replacer{pattern: []rune(find), replace: replace, fold: !caseSensitive, budget: budget}
}

func foldEqual(a, b rune) bool {
	if a == b {
		return true
	}
	for r := unicode.SimpleFold(a); r != a; r = unicode.SimpleFold(r) {
		if r == b {
			return true
		}
	}
	return false
}

func (r *replacer) matchesAt(text []rune, i int) bool {
	if i+len(r.pattern) > len(text) {
		return false
	}
	for j, p := range r.pattern {
		if r.fold {
			if !foldEqual(text[i+j], p) {
				return false
			}
		} else if text[i+j] != p {
			return false
		}
	}
	return true
}

// find lists non-overlapping matches from the left, at most limit of them.
func (r *replacer) find(text []rune, limit int) [][2]int {
	var out [][2]int
	for i := 0; i < len(text) && len(out) < limit; {
		if r.matchesAt(text, i) {
			out = append(out, [2]int{i, i + len(r.pattern)})
			i += len(r.pattern)
		} else {
			i++
		}
	}
	return out
}

func (r *replacer) str(text string) string {
	if r.budget <= 0 {
		return text
	}
	runes := []rune(text)
	found := r.find(runes, r.budget)
	out := make([]rune, 0, len(runes))
	last := 0
	for _, m := range found {
		out = append(out, runes[last:m[0]]...)
		out = append(out, []rune(r.replace)...)
		last = m[1]
	}
	out = append(out, runes[last:]...)
	r.budget -= len(found)
	r.count += len(found)
	return string(out)
}

func (r *replacer) optional(v any) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	return r.str(s), true
}

func runsText(runs []any) string {
	var out []rune
	for _, run := range runs {
		out = append(out, []rune(run.(record)["text"].(string))...)
	}
	return string(out)
}

// runs replaces across run boundaries; the replacement takes the formatting of the run where the match starts.
func (r *replacer) runs(runs []any) []any {
	if r.budget <= 0 {
		return runs
	}
	full := []rune(runsText(runs))
	found := r.find(full, r.budget)
	if len(found) == 0 {
		return append([]any(nil), runs...)
	}
	r.budget -= len(found)
	r.count += len(found)
	out := make([]any, 0, len(runs))
	offset := 0
	for _, item := range runs {
		run := item.(record)
		runLen := len([]rune(run["text"].(string)))
		runStart, runEnd := offset, offset+runLen
		offset = runEnd
		var text []rune
		cursor := runStart
		for _, m := range found {
			if m[1] <= cursor {
				continue
			}
			if m[0] >= runEnd {
				break
			}
			if m[0] > cursor {
				text = append(text, full[cursor:m[0]]...)
				cursor = m[0]
			}
			if m[0] >= runStart {
				text = append(text, []rune(r.replace)...)
			}
			cursor = min(m[1], runEnd)
		}
		text = append(text, full[cursor:runEnd]...)
		// Runs emptied by the replacement disappear, except citation markers, which carry meaning without text.
		_, cited := run["citationId"]
		if len(text) > 0 || runLen == 0 || cited {
			copy := shallow(run)
			copy["text"] = string(text)
			out = append(out, copy)
		}
	}
	return out
}

func shallow(r record) record {
	out := make(record, len(r))
	for k, v := range r {
		out[k] = v
	}
	return out
}

func (r *replacer) strings(items []any) []any {
	out := make([]any, len(items))
	for i, item := range items {
		out[i] = r.str(item.(string))
	}
	return out
}

// replaceInContent returns the new content and the number of replacements, or ok=false for blocks without text.
func replaceInContent(content record, find, replace string, all, caseSensitive bool) (record, int, bool) {
	r := newReplacer(find, replace, all, caseSensitive)
	next := shallow(content)
	switch content["type"] {
	case "section", "toggle":
		next["title"] = r.str(content["title"].(string))
	case "heading", "code":
		next["text"] = r.str(content["text"].(string))
	case "paragraph":
		next["runs"] = r.runs(content["runs"].([]any))
	case "quote":
		next["runs"] = r.runs(content["runs"].([]any))
		if s, ok := r.optional(content["attribution"]); ok {
			next["attribution"] = s
		}
	case "callout":
		if s, ok := r.optional(content["title"]); ok {
			next["title"] = s
		}
		next["runs"] = r.runs(content["runs"].([]any))
	case "list":
		next["items"] = r.strings(content["items"].([]any))
	case "table":
		if s, ok := r.optional(content["caption"]); ok {
			next["caption"] = s
		}
		next["columns"] = r.strings(content["columns"].([]any))
		rows := content["rows"].([]any)
		newRows := make([]any, len(rows))
		for i, row := range rows {
			newRows[i] = r.strings(row.([]any))
		}
		next["rows"] = newRows
	case "chart":
		spec := shallow(content["spec"].(record))
		// The reference replaces the caption before the title.
		if s, ok := r.optional(spec["caption"]); ok {
			spec["caption"] = s
		}
		spec["title"] = r.str(spec["title"].(string))
		next["spec"] = spec
	case "embed":
		next["title"] = r.str(content["title"].(string))
	case "image":
		if s, ok := r.optional(content["caption"]); ok {
			next["caption"] = s
		}
		next["alt"] = r.str(content["alt"].(string))
	case "metrics":
		items := content["items"].([]any)
		newItems := make([]any, len(items))
		for i, it := range items {
			item := shallow(it.(record))
			item["label"] = r.str(item["label"].(string))
			item["value"] = r.str(item["value"].(string))
			if s, ok := r.optional(item["hint"]); ok {
				item["hint"] = s
			}
			newItems[i] = item
		}
		next["items"] = newItems
	case "timestamp":
		next["label"] = r.str(content["label"].(string))
	default:
		return nil, 0, false
	}
	return next, r.count, true
}

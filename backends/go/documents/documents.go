// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

// Package documents holds the pure document functions of Super Editor: block text extraction, the
// structural diff between two documents and one-line revision summaries.
//
// It ports packages/core/src/text.ts and diff.ts from the TypeScript reference;
// conformance/document-ops.v1.json pins every behaviour. Documents are decoded JSON
// (map[string]any, []any, string, float64, bool, nil).
//
// Limits: titles in summaries are sliced by UTF-16 code units in the reference, so the data uses
// BMP characters only; the reference compares blocks through JSON.stringify, so there objects must
// keep a stable key order to count as equal (here they compare as values).
package documents

import (
	"fmt"
	"reflect"
	"strings"
	"unicode/utf16"
)

type obj = map[string]any

func str(m obj, key string) string { s, _ := m[key].(string); return s }

func list(v any) []any { l, _ := v.([]any); return l }

func object(v any) obj { m, _ := v.(obj); return m }

func optional(m obj, key string) []string {
	if s, ok := m[key].(string); ok {
		return []string{s}
	}
	return nil
}

func runsText(runs any) string {
	var b strings.Builder
	for _, r := range list(runs) {
		b.WriteString(str(object(r), "text"))
	}
	return b.String()
}

func join(rows any, sep string) string {
	var parts []string
	for _, c := range list(rows) {
		parts = append(parts, c.(string))
	}
	return strings.Join(parts, sep)
}

// TextParts is the human-visible, replaceable text of a block, one string per text field in
// document order.
func TextParts(content obj) []string {
	switch str(content, "type") {
	case "section", "toggle":
		return []string{str(content, "title")}
	case "heading", "code":
		return []string{str(content, "text")}
	case "paragraph":
		return []string{runsText(content["runs"])}
	case "quote":
		return append([]string{runsText(content["runs"])}, optional(content, "attribution")...)
	case "callout":
		return append(optional(content, "title"), runsText(content["runs"]))
	case "list":
		out := []string{}
		for _, item := range list(content["items"]) {
			out = append(out, item.(string))
		}
		return out
	case "table":
		out := optional(content, "caption")
		out = append(out, join(content["columns"], "\t"))
		for _, row := range list(content["rows"]) {
			out = append(out, join(row, "\t"))
		}
		return out
	case "chart":
		spec := object(content["spec"])
		return append([]string{str(spec, "title")}, optional(spec, "caption")...)
	case "embed":
		return []string{str(content, "title")}
	case "image":
		return append([]string{str(content, "alt")}, optional(content, "caption")...)
	case "metrics":
		out := []string{}
		for _, raw := range list(content["items"]) {
			item := object(raw)
			out = append(out, str(item, "label"), str(item, "value"))
			out = append(out, optional(item, "hint")...)
		}
		return out
	case "timestamp":
		return []string{str(content, "label")}
	}
	return []string{} // divider, toc, pageBreak
}

// ContentText joins TextParts with newlines.
func ContentText(content obj) string { return strings.Join(TextParts(content), "\n") }

// CitationDiff lists citation ids that were added, removed or changed.
type CitationDiff struct {
	Added   []string `json:"added"`
	Removed []string `json:"removed"`
	Changed []string `json:"changed"`
}

// DocumentDiff is the structural difference between two documents, by block id.
type DocumentDiff struct {
	Added         []string     `json:"added"`
	Removed       []string     `json:"removed"`
	Changed       []string     `json:"changed"`
	Moved         []string     `json:"moved"`
	TitleChanged  bool         `json:"titleChanged"`
	FormatChanged bool         `json:"formatChanged"`
	Citations     CitationDiff `json:"citations"`
}

// stable returns the positions of a longest increasing subsequence of values; only the blocks
// outside it count as moved.
func stable(values []int) map[int]bool {
	var tails []int
	previous := make([]int, len(values))
	for i := range previous {
		previous[i] = -1
	}
	for index, value := range values {
		low, high := 0, len(tails)
		for low < high {
			middle := (low + high) >> 1
			if values[tails[middle]] < value {
				low = middle + 1
			} else {
				high = middle
			}
		}
		if low > 0 {
			previous[index] = tails[low-1]
		}
		if low == len(tails) {
			tails = append(tails, index)
		} else {
			tails[low] = index
		}
	}
	keep := map[int]bool{}
	cursor := -1
	if len(tails) > 0 {
		cursor = tails[len(tails)-1]
	}
	for ; cursor >= 0; cursor = previous[cursor] {
		keep[cursor] = true
	}
	return keep
}

// parentOf is the block's parent id, or "\x00" for a top-level block (ids are printable text).
func parentOf(block obj) string {
	if s, ok := block["parentId"].(string); ok {
		return s
	}
	return "\x00"
}

// DiffDocuments compares two documents by block id. Versions and timestamps are ignored: only
// content, citation ids, parent and sibling order count.
func DiffDocuments(a, b obj) DocumentDiff {
	aBlocks, bBlocks := list(a["blocks"]), list(b["blocks"])
	before := map[string]obj{}
	for _, raw := range aBlocks {
		before[str(object(raw), "id")] = object(raw)
	}
	after := map[string]obj{}
	for _, raw := range bBlocks {
		after[str(object(raw), "id")] = object(raw)
	}
	d := DocumentDiff{Added: []string{}, Removed: []string{}, Changed: []string{}, Moved: []string{},
		Citations: CitationDiff{Added: []string{}, Removed: []string{}, Changed: []string{}}}
	for _, raw := range bBlocks {
		if id := str(object(raw), "id"); before[id] == nil {
			d.Added = append(d.Added, id)
		}
	}
	for _, raw := range aBlocks {
		if id := str(object(raw), "id"); after[id] == nil {
			d.Removed = append(d.Removed, id)
		}
	}
	moved := map[string]bool{}
	for _, raw := range bBlocks {
		block := object(raw)
		old := before[str(block, "id")]
		if old == nil {
			continue
		}
		if !reflect.DeepEqual([]any{old["content"], old["citationIds"]}, []any{block["content"], block["citationIds"]}) {
			d.Changed = append(d.Changed, str(block, "id"))
		}
		if parentOf(old) != parentOf(block) {
			moved[str(block, "id")] = true
		}
	}
	// Within each parent, blocks that kept their parent but fell out of the common order were reordered.
	var parents []string
	seenParent := map[string]bool{}
	for _, raw := range bBlocks {
		if p := parentOf(object(raw)); !seenParent[p] {
			seenParent[p] = true
			parents = append(parents, p)
		}
	}
	for _, parent := range parents {
		order := map[string]int{}
		n := 0
		for _, raw := range aBlocks {
			if parentOf(object(raw)) == parent {
				order[str(object(raw), "id")] = n
				n++
			}
		}
		var common []obj
		var positions []int
		for _, raw := range bBlocks {
			block := object(raw)
			if pos, ok := order[str(block, "id")]; ok && parentOf(block) == parent {
				common = append(common, block)
				positions = append(positions, pos)
			}
		}
		keep := stable(positions)
		for i, block := range common {
			if !keep[i] {
				moved[str(block, "id")] = true
			}
		}
	}
	for _, raw := range bBlocks {
		if id := str(object(raw), "id"); moved[id] {
			d.Moved = append(d.Moved, id)
		}
	}
	d.TitleChanged = str(a, "title") != str(b, "title")
	d.FormatChanged = !reflect.DeepEqual(a["format"], b["format"])
	oldC, newC := map[string]obj{}, map[string]obj{}
	for _, raw := range list(a["citations"]) {
		oldC[str(object(raw), "id")] = object(raw)
	}
	for _, raw := range list(b["citations"]) {
		newC[str(object(raw), "id")] = object(raw)
	}
	for _, raw := range list(b["citations"]) {
		c := object(raw)
		id := str(c, "id")
		if old, ok := oldC[id]; !ok {
			d.Citations.Added = append(d.Citations.Added, id)
		} else if !reflect.DeepEqual(old, c) {
			d.Citations.Changed = append(d.Citations.Changed, id)
		}
	}
	for _, raw := range list(a["citations"]) {
		if id := str(object(raw), "id"); newC[id] == nil {
			d.Citations.Removed = append(d.Citations.Removed, id)
		}
	}
	return d
}

func plural(count int, noun string) string {
	if count == 1 {
		return fmt.Sprintf("%d %s", count, noun)
	}
	return fmt.Sprintf("%d %ss", count, noun)
}

func sentence(parts []string) string {
	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	}
	return strings.Join(parts[:len(parts)-1], ", ") + " and " + parts[len(parts)-1]
}

func utf16Length(s string) int { return len(utf16.Encode([]rune(s))) }

// SummarizeRevision is one human sentence for a revision, for history lists and toasts.
func SummarizeRevision(revision obj) string {
	actor := object(revision["actor"])
	kind := str(actor, "kind")
	who := strings.ToUpper(kind[:1]) + kind[1:] + " " + str(actor, "id")
	switch str(revision, "kind") {
	case "undo":
		return who + " undid the previous change."
	case "redo":
		return who + " redid a change."
	}
	ops := list(revision["operations"])
	touched := func(pick func(op obj) []string) int {
		seen := map[string]bool{}
		for _, raw := range ops {
			for _, id := range pick(object(raw)) {
				seen[id] = true
			}
		}
		return len(seen)
	}
	blockIDs := func(op obj) []string {
		var ids []string
		for _, b := range list(op["blocks"]) {
			ids = append(ids, str(object(b), "blockId"))
		}
		return ids
	}
	count := func(opType string) int {
		n := 0
		for _, raw := range ops {
			if str(object(raw), "type") == opType {
				n++
			}
		}
		return n
	}
	inserted := count("insertBlock")
	for _, raw := range ops {
		if op := object(raw); str(op, "type") == "insertBlocks" {
			inserted += len(list(op["blocks"]))
		}
	}
	single := func(opType string) func(obj) []string {
		return func(op obj) []string {
			if str(op, "type") == opType {
				return []string{str(op, "blockId")}
			}
			return nil
		}
	}
	multi := func(single, many string) func(obj) []string {
		return func(op obj) []string {
			switch str(op, "type") {
			case single:
				return []string{str(op, "blockId")}
			case many:
				return blockIDs(op)
			}
			return nil
		}
	}
	var parts []string
	if inserted > 0 {
		parts = append(parts, "inserted "+plural(inserted, "block"))
	}
	if n := count("duplicateBlock"); n > 0 {
		parts = append(parts, "duplicated "+plural(n, "block"))
	}
	if n := touched(single("updateBlock")); n > 0 {
		parts = append(parts, "edited "+plural(n, "block"))
	}
	if n := touched(single("replaceText")); n > 0 {
		parts = append(parts, "replaced text in "+plural(n, "block"))
	}
	if n := touched(multi("moveBlock", "moveBlocks")); n > 0 {
		parts = append(parts, "moved "+plural(n, "block"))
	}
	if n := touched(multi("deleteBlock", "deleteBlocks")); n > 0 {
		parts = append(parts, "deleted "+plural(n, "block"))
	}
	for i := len(ops) - 1; i >= 0; i-- {
		if op := object(ops[i]); str(op, "type") == "setTitle" {
			name := str(op, "title")
			if utf16Length(name) > 60 {
				name = string(utf16.Decode(utf16.Encode([]rune(name))[:57])) + "..."
			}
			parts = append(parts, "renamed the document to “"+name+"”")
			break
		}
	}
	if count("setFormat") > 0 {
		parts = append(parts, "changed the page format")
	}
	if n := count("addCitation"); n > 0 {
		parts = append(parts, "added "+plural(n, "citation"))
	}
	if n := count("updateCitation"); n > 0 {
		parts = append(parts, "updated "+plural(n, "citation"))
	}
	if n := count("removeCitation"); n > 0 {
		parts = append(parts, "removed "+plural(n, "citation"))
	}
	if len(parts) == 0 {
		return who + " made no changes."
	}
	return who + " " + sentence(parts) + "."
}

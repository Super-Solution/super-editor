// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package render

import (
	"strings"
	"unicode"

	"github.com/Super-Solution/super-editor/backends/go/documents"
)

func blocksOf(doc record) []record {
	list, _ := doc["blocks"].([]any)
	out := make([]record, len(list))
	for i, b := range list {
		out[i], _ = b.(record)
	}
	return out
}

func idOf(b record) string { s, _ := b["id"].(string); return s }

func contentOf(b record) record { c, _ := b["content"].(record); return c }

func typeOf(b record) string { s, _ := contentOf(b)["type"].(string); return s }

// parentKey is the parent's id, or "" for top-level blocks (ids are never empty).
func parentKey(b record) string { s, _ := b["parentId"].(string); return s }

func childIndex(blocks []record) map[string][]record {
	index := map[string][]record{}
	for _, b := range blocks {
		index[parentKey(b)] = append(index[parentKey(b)], b)
	}
	return index
}

// OrderedBlocks lists all blocks in reading order: a pre-order walk of the tree, siblings in stored order.
func OrderedBlocks(doc record) []record {
	blocks := blocksOf(doc)
	index := childIndex(blocks)
	seen := map[string]bool{}
	out := []record{}
	var walk func(parent string)
	walk = func(parent string) {
		for _, b := range index[parent] {
			if seen[idOf(b)] {
				continue
			}
			seen[idOf(b)] = true
			out = append(out, b)
			walk(idOf(b))
		}
	}
	walk("")
	// A valid document has no unreachable blocks; keep any that exist rather than dropping data.
	for _, b := range blocks {
		if !seen[idOf(b)] {
			out = append(out, b)
		}
	}
	return out
}

// DescendantsOf lists every block below id, in reading order.
func DescendantsOf(doc record, id string) []record {
	index := childIndex(blocksOf(doc))
	seen := map[string]bool{id: true}
	out := []record{}
	var walk func(parent string)
	walk = func(parent string) {
		for _, b := range index[parent] {
			if seen[idOf(b)] {
				continue
			}
			seen[idOf(b)] = true
			out = append(out, b)
			walk(idOf(b))
		}
	}
	walk(id)
	return out
}

// BlockText is the searchable text of a block: every text field joined by newlines.
func BlockText(b record) string { return documents.ContentText(contentOf(b)) }

// Selector narrows FindBlocks; selectors combine with AND. A nil field is not applied.
type Selector struct {
	Types         []string
	Text          *string
	CaseSensitive bool
	// ParentID: nil means any parent; a pointer to "" selects the top level.
	ParentID   *string
	IDs        []string
	CitationID *string
	Within     *string
	Limit      *int
}

// FindBlocks returns the matching blocks in reading order. An empty selector returns every block.
func FindBlocks(doc record, s Selector) []record {
	var types, ids, within map[string]bool
	if s.Types != nil {
		types = map[string]bool{}
		for _, t := range s.Types {
			types[t] = true
		}
	}
	if s.IDs != nil {
		ids = map[string]bool{}
		for _, id := range s.IDs {
			ids[id] = true
		}
	}
	if s.Within != nil {
		within = map[string]bool{}
		for _, b := range DescendantsOf(doc, *s.Within) {
			within[idOf(b)] = true
		}
	}
	needle := ""
	if s.Text != nil {
		needle = *s.Text
		if !s.CaseSensitive {
			needle = jsLower(needle)
		}
	}
	out := []record{}
	for _, b := range OrderedBlocks(doc) {
		if s.Limit != nil && len(out) >= *s.Limit {
			break
		}
		if types != nil && !types[typeOf(b)] {
			continue
		}
		if ids != nil && !ids[idOf(b)] {
			continue
		}
		if s.ParentID != nil && parentKey(b) != *s.ParentID {
			continue
		}
		if within != nil && !within[idOf(b)] {
			continue
		}
		if s.CitationID != nil && !cites(b, *s.CitationID) {
			continue
		}
		if s.Text != nil {
			text := BlockText(b)
			if !s.CaseSensitive {
				text = jsLower(text)
			}
			if !strings.Contains(text, needle) {
				continue
			}
		}
		out = append(out, b)
	}
	return out
}

func cites(b record, id string) bool {
	ids, _ := b["citationIds"].([]any)
	for _, c := range ids {
		if c == id {
			return true
		}
	}
	for _, r := range RunsOf(contentOf(b)) {
		if r.HasCitation && r.CitationID == id {
			return true
		}
	}
	return false
}

// jsLower is String.prototype.toLowerCase for the common cases: simple lower-casing, with the final-sigma and
// dotted-capital-I special cases of the full mapping.
func jsLower(s string) string {
	var out strings.Builder
	rs := []rune(s)
	for i, r := range rs {
		switch {
		case r == 0x130: // İ lower-cases to i + combining dot above
			out.WriteString("i̇")
		case r == 0x3a3: // Σ becomes ς at the end of a word, otherwise σ
			if finalSigma(rs, i) {
				out.WriteRune(0x3c2)
			} else {
				out.WriteRune(0x3c3)
			}
		default:
			out.WriteRune(unicode.ToLower(r))
		}
	}
	return out.String()
}

func cased(r rune) bool { return unicode.IsUpper(r) || unicode.IsLower(r) || unicode.IsTitle(r) }

func caseIgnorable(r rune) bool {
	switch r {
	case '\'', '.', ':', '^', '`', 0xa8, 0xad, 0xaf, 0xb4, 0xb7, 0xb8, 0x2019, 0x2018, 0x2024, 0x2027:
		return true
	}
	return unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Me, r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Lm, r) || unicode.Is(unicode.Sk, r)
}

// finalSigma reports whether the capital sigma at i ends a word: preceded by a cased letter and not followed by one.
func finalSigma(rs []rune, i int) bool {
	before := false
	for j := i - 1; j >= 0; j-- {
		if caseIgnorable(rs[j]) {
			continue
		}
		before = cased(rs[j])
		break
	}
	if !before {
		return false
	}
	for j := i + 1; j < len(rs); j++ {
		if caseIgnorable(rs[j]) {
			continue
		}
		return !cased(rs[j])
	}
	return true
}

// OutlineItem is one entry of the document outline.
type OutlineItem struct {
	ID       string
	Type     string // "section" or "heading"
	Title    string
	Level    int
	Children []*OutlineItem
}

// Record converts the item (and its children) to the generic JSON form.
func (o *OutlineItem) Record() record {
	children := make([]any, len(o.Children))
	for i, c := range o.Children {
		children[i] = c.Record()
	}
	return record{"id": o.ID, "type": o.Type, "title": o.Title, "level": float64(o.Level), "children": children}
}

// Outline is the document's skeleton. Sections nest by containment and headings nest by level inside their
// container; a section closes the headings before it, and toggles are transparent.
func Outline(doc record) []*OutlineItem {
	index := childIndex(blocksOf(doc))
	seen := map[string]bool{}
	var entries func(parent string, depth int) []*OutlineItem
	nest := func(list []*OutlineItem) []*OutlineItem {
		root := []*OutlineItem{}
		var stack []*OutlineItem
		for _, item := range list {
			if item.Type == "section" {
				stack = nil
				root = append(root, item)
				continue
			}
			for len(stack) > 0 && stack[len(stack)-1].Level >= item.Level {
				stack = stack[:len(stack)-1]
			}
			if len(stack) > 0 {
				top := stack[len(stack)-1]
				top.Children = append(top.Children, item)
			} else {
				root = append(root, item)
			}
			stack = append(stack, item)
		}
		return root
	}
	entries = func(parent string, depth int) []*OutlineItem {
		var out []*OutlineItem
		for _, b := range index[parent] {
			if seen[idOf(b)] {
				continue
			}
			seen[idOf(b)] = true
			c := contentOf(b)
			switch c["type"] {
			case "section":
				title, _ := c["title"].(string)
				out = append(out, &OutlineItem{ID: idOf(b), Type: "section", Title: title, Level: depth, Children: nest(entries(idOf(b), depth+1))})
			case "heading":
				text, _ := c["text"].(string)
				level, _ := c["level"].(float64)
				out = append(out, &OutlineItem{ID: idOf(b), Type: "heading", Title: text, Level: int(level), Children: []*OutlineItem{}})
			case "toggle":
				out = append(out, entries(idOf(b), depth)...)
			}
		}
		return out
	}
	return nest(entries("", 1))
}

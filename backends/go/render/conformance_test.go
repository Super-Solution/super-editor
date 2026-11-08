// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package render

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type fixture struct {
	Inline []struct {
		Input    string           `json:"input"`
		Runs     []map[string]any `json:"runs"`
		Markdown string           `json:"markdown"`
		Plain    string           `json:"plain"`
	} `json:"inline"`
	RunsToMarkdown []struct {
		Runs     []any  `json:"runs"`
		Markdown string `json:"markdown"`
	} `json:"runsToMarkdown"`
	FromMarkdown []struct {
		Markdown string `json:"markdown"`
		Options  struct {
			IDPrefix        string  `json:"idPrefix"`
			ParentID        *string `json:"parentId"`
			CitationMarkers *bool   `json:"citationMarkers"`
		} `json:"options"`
		Blocks []any `json:"blocks"`
	} `json:"fromMarkdown"`
	BadPrefixes []struct {
		IDPrefix string `json:"idPrefix"`
		Error    string `json:"error"`
	} `json:"badPrefixes"`
	Documents []struct {
		Document       map[string]any `json:"document"`
		Markdown       string         `json:"markdown"`
		MarkdownBare   string         `json:"markdownBare"`
		HTML           string         `json:"html"`
		HTMLBare       string         `json:"htmlBare"`
		HTMLStandalone string         `json:"htmlStandalone"`
		Text           string         `json:"text"`
		TextBare       string         `json:"textBare"`
		Stats          any            `json:"stats"`
		Outline        any            `json:"outline"`
		Queries        []struct {
			Selector map[string]any `json:"selector"`
			IDs      []string       `json:"ids"`
		} `json:"queries"`
	} `json:"documents"`
	Words []struct {
		Text  string `json:"text"`
		Latin int    `json:"latin"`
		CJK   int    `json:"cjk"`
	} `json:"words"`
}

func roundTrip(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func selectorOf(m map[string]any) Selector {
	var s Selector
	switch v := m["type"].(type) {
	case string:
		s.Types = []string{v}
	case []any:
		s.Types = []string{}
		for _, x := range v {
			s.Types = append(s.Types, x.(string))
		}
	}
	if v, ok := m["text"].(string); ok {
		s.Text = &v
	}
	s.CaseSensitive, _ = m["caseSensitive"].(bool)
	if v, ok := m["parentId"]; ok {
		p := ""
		if str, isStr := v.(string); isStr {
			p = str
		}
		s.ParentID = &p
	}
	if v, ok := m["ids"].([]any); ok {
		s.IDs = []string{}
		for _, x := range v {
			s.IDs = append(s.IDs, x.(string))
		}
	}
	if v, ok := m["citationId"].(string); ok {
		s.CitationID = &v
	}
	if v, ok := m["within"].(string); ok {
		s.Within = &v
	}
	if v, ok := m["limit"].(float64); ok {
		n := int(v)
		s.Limit = &n
	}
	return s
}

func TestConformance(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "conformance", "render.v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	failures := 0
	fail := func(format string, args ...any) {
		failures++
		if failures <= 40 {
			t.Errorf(format, args...)
		}
	}
	for i, c := range f.Inline {
		runs := ParseInline(c.Input)
		if got := roundTrip(t, RunsToAny(runs)); !reflect.DeepEqual(got, roundTrip(t, c.Runs)) {
			fail("inline %d %q: runs\n got  %v\n want %v", i, c.Input, got, c.Runs)
			continue
		}
		if got := RunsToMarkdown(runs); got != c.Markdown {
			fail("inline %d %q: markdown %q, want %q", i, c.Input, got, c.Markdown)
		}
		if got := InlineToPlain(c.Input); got != c.Plain {
			fail("inline %d %q: plain %q, want %q", i, c.Input, got, c.Plain)
		}
	}
	for i, c := range f.RunsToMarkdown {
		if got := RunsToMarkdown(runsFromAny(c.Runs)); got != c.Markdown {
			fail("runsToMarkdown %d %v: %q, want %q", i, c.Runs, got, c.Markdown)
		}
	}
	for i, c := range f.FromMarkdown {
		o := FromMarkdownOptions{IDPrefix: c.Options.IDPrefix, NoCitationMarkers: c.Options.CitationMarkers != nil && !*c.Options.CitationMarkers}
		if c.Options.ParentID != nil {
			o.ParentID = *c.Options.ParentID
		}
		blocks, err := FromMarkdown(c.Markdown, o)
		if err != nil {
			t.Fatal(err)
		}
		list := make([]any, len(blocks))
		for j, b := range blocks {
			list[j] = b
		}
		if got := roundTrip(t, list); !reflect.DeepEqual(got, roundTrip(t, c.Blocks)) {
			gb, _ := json.Marshal(got)
			wb, _ := json.Marshal(c.Blocks)
			fail("fromMarkdown %d %q\n got  %s\n want %s", i, c.Markdown, gb, wb)
		}
	}
	for _, c := range f.BadPrefixes {
		if _, err := FromMarkdown("x", FromMarkdownOptions{IDPrefix: c.IDPrefix}); err == nil {
			fail("prefix %q accepted", c.IDPrefix)
		}
	}
	for i, c := range f.Documents {
		d := c.Document
		check := func(name, got, want string) {
			if got != want {
				fail("document %d %s differs\n got  %q\n want %q", i, name, got, want)
			}
		}
		check("markdown", ToMarkdown(d, MarkdownOptions{}), c.Markdown)
		check("markdownBare", ToMarkdown(d, MarkdownOptions{NoTitle: true, ChartRows: 2}), c.MarkdownBare)
		check("html", ToHTML(d, HTMLOptions{}), c.HTML)
		check("htmlBare", ToHTML(d, HTMLOptions{NoTitle: true, ChartRows: 2}), c.HTMLBare)
		check("htmlStandalone", ToHTML(d, HTMLOptions{Standalone: true}), c.HTMLStandalone)
		check("text", ToPlainText(d, TextOptions{}), c.Text)
		check("textBare", ToPlainText(d, TextOptions{NoTitle: true, ChartRows: 1}), c.TextBare)
		if got := roundTrip(t, Stats(d)); !reflect.DeepEqual(got, c.Stats) {
			fail("document %d stats\n got  %v\n want %v", i, got, c.Stats)
		}
		outline := []any{}
		for _, item := range Outline(d) {
			outline = append(outline, item.Record())
		}
		if got := roundTrip(t, outline); !reflect.DeepEqual(got, c.Outline) {
			fail("document %d outline\n got  %v\n want %v", i, got, c.Outline)
		}
		for _, q := range c.Queries {
			ids := []string{}
			for _, b := range FindBlocks(d, selectorOf(q.Selector)) {
				ids = append(ids, idOf(b))
			}
			if !reflect.DeepEqual(ids, q.IDs) && !(len(ids) == 0 && len(q.IDs) == 0) {
				fail("document %d query %v: %v, want %v", i, q.Selector, ids, q.IDs)
			}
		}
	}
	for _, w := range f.Words {
		if l, c := CountWords(w.Text); l != w.Latin || c != w.CJK {
			fail("words %q: %d/%d, want %d/%d", w.Text, l, c, w.Latin, w.CJK)
		}
	}
	if failures > 0 {
		t.Fatalf("%d failures", failures)
	}
}

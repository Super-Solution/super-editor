// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package documents

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type fixtures struct {
	TextParts []struct {
		Content obj      `json:"content"`
		Expect  []string `json:"expect"`
	} `json:"text_parts"`
	Diff []struct {
		A      obj          `json:"a"`
		B      obj          `json:"b"`
		Expect DocumentDiff `json:"expect"`
	} `json:"diff"`
	Summaries []struct {
		Revision obj    `json:"revision"`
		Expect   string `json:"expect"`
	} `json:"summarize_revision"`
}

func load(t testing.TB) fixtures {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "conformance", "document-ops.v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f fixtures
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestTextParts(t *testing.T) {
	f := load(t)
	if len(f.TextParts) < 150 {
		t.Fatalf("only %d cases", len(f.TextParts))
	}
	for i, c := range f.TextParts {
		if got := TextParts(c.Content); !reflect.DeepEqual(got, c.Expect) {
			t.Errorf("text_parts[%d]: %q, want %q", i, got, c.Expect)
		}
	}
}

func TestDiff(t *testing.T) {
	f := load(t)
	if len(f.Diff) < 150 {
		t.Fatalf("only %d cases", len(f.Diff))
	}
	for i, c := range f.Diff {
		if got := DiffDocuments(c.A, c.B); !reflect.DeepEqual(got, c.Expect) {
			t.Errorf("diff[%d]: %+v, want %+v", i, got, c.Expect)
		}
	}
}

func TestSummarizeRevision(t *testing.T) {
	f := load(t)
	if len(f.Summaries) < 150 {
		t.Fatalf("only %d cases", len(f.Summaries))
	}
	for i, c := range f.Summaries {
		if got := SummarizeRevision(c.Revision); got != c.Expect {
			t.Errorf("summary[%d]: %q, want %q", i, got, c.Expect)
		}
	}
}

func BenchmarkDiff(b *testing.B) {
	f := load(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		c := f.Diff[i%len(f.Diff)]
		DiffDocuments(c.A, c.B)
	}
}

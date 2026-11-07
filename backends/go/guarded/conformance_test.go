// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package guarded

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type step struct {
	Now         string      `json:"now"`
	Transaction Transaction `json:"transaction"`
	Expect      struct {
		OK              bool            `json:"ok"`
		Duplicate       bool            `json:"duplicate"`
		Document        json.RawMessage `json:"document"`
		Issues          []Issue         `json:"issues"`
		CurrentRevision int64           `json:"currentRevision"`
	} `json:"expect"`
}

type data struct {
	Scenarios []struct {
		Name    string   `json:"name"`
		Initial Document `json:"initial"`
		Steps   []step   `json:"steps"`
	} `json:"scenarios"`
}

func asAny(t *testing.T, v any) any {
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

func TestConformance(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "conformance", "guarded-apply.v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var d data
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	steps, failures, duplicates := 0, 0, 0
	for _, sc := range d.Scenarios {
		editor := New(sc.Initial)
		for i, st := range sc.Steps {
			steps++
			got := editor.Apply(st.Transaction, st.Now)
			where := func() string { return sc.Name + " step " + string(rune('0'+i/10)) + string(rune('0'+i%10)) }
			if got.OK != st.Expect.OK {
				t.Errorf("%s: ok=%v, want %v (issues %v)", where(), got.OK, st.Expect.OK, got.Issues)
				continue
			}
			if st.Expect.OK {
				if got.Duplicate != st.Expect.Duplicate {
					t.Errorf("%s: duplicate=%v, want %v", where(), got.Duplicate, st.Expect.Duplicate)
				}
				if st.Expect.Duplicate {
					duplicates++
				}
				var want any
				_ = json.Unmarshal(st.Expect.Document, &want)
				if !reflect.DeepEqual(asAny(t, got.Document), want) {
					t.Errorf("%s: document differs", where())
				}
				continue
			}
			failures++
			if !reflect.DeepEqual(got.Issues, st.Expect.Issues) || got.CurrentRevision != st.Expect.CurrentRevision {
				t.Errorf("%s: issues %v rev %d, want %v rev %d", where(), got.Issues, got.CurrentRevision, st.Expect.Issues, st.Expect.CurrentRevision)
			}
		}
	}
	if steps < 250 || failures < 40 || duplicates < 1 {
		t.Fatalf("fixture too thin: %d steps, %d failures, %d duplicates", steps, failures, duplicates)
	}
}

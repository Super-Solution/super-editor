// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package validation

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func documentWithRetired(t *testing.T, count int) any {
	t.Helper()
	ids := make([]string, count)
	for i := range ids {
		ids[i] = fmt.Sprintf(`"r%d"`, i)
	}
	raw := `{"schemaVersion":1,"id":"d","title":"T","revision":0,"createdAt":"2026-10-03T12:00:00.000Z","updatedAt":"2026-10-03T12:00:00.000Z",` +
		`"format":{"page":"screen","font":"sans","fontSize":16,"lineHeight":1.6},"blocks":[],"citations":[],"retiredBlockIds":[` + strings.Join(ids, ",") + `]}`
	value, err := Decode([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestRetiredLimitSaysHowToRecover(t *testing.T) {
	if res := ValidateDocument(documentWithRetired(t, limitRetired)); !res.OK {
		t.Fatalf("a document exactly at the limit is valid: %v", res.Issues)
	}
	res := ValidateDocument(documentWithRetired(t, limitRetired+1))
	if res.OK || len(res.Issues) != 1 {
		t.Fatalf("one over the limit must be refused with one issue, got %v", res)
	}
	issue := res.Issues[0]
	if issue.Path != "document.retiredBlockIds" || issue.Message != "Expected an array with at most 100000 entries." || issue.Hint != retiredLimitHint {
		t.Errorf("unexpected issue %+v", issue)
	}
}

// The hint is a sentence the three implementations must agree on, so the reference's own source is the oracle.
func TestRetiredLimitHintMatchesTypeScript(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "core", "src", "validation.ts"))
	if err != nil {
		t.Skip("TypeScript source not next to the backend:", err)
	}
	if !strings.Contains(string(source), "RETIRED_LIMIT_HINT = '"+retiredLimitHint+"'") {
		t.Error("retiredLimitHint differs from RETIRED_LIMIT_HINT in packages/core/src/validation.ts")
	}
}

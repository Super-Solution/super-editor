// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package server

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/Super-Solution/super-editor/backends/go/validation"
)

const (
	prefixSentinel  = "ZZPFXZZ"
	subjectSentinel = "ZZSUBJZZ"
	subjectMax      = 200
)

var templatePrefix = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,59}$`)

func isSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// collapseSpace replaces every run of JavaScript whitespace with one space (`/\s+/g, ' '`).
func collapseSpace(s string) string {
	var out strings.Builder
	inRun := false
	for _, r := range s {
		if isSpace(r) {
			if !inRun {
				out.WriteByte(' ')
			}
			inRun = true
			continue
		}
		inRun = false
		out.WriteRune(r)
	}
	return out.String()
}

func jsTrim(s string) string { return strings.TrimFunc(s, isSpace) }

// cleanSubject collapses whitespace and drops control characters so a subject cannot break the one-line titles.
func cleanSubject(value string) (string, error) {
	var b strings.Builder
	inRun := false
	for _, r := range value {
		if r <= 0x1f || r == 0x7f {
			if !inRun {
				b.WriteByte(' ')
			}
			inRun = true
			continue
		}
		inRun = false
		b.WriteRune(r)
	}
	cleaned := jsTrim(collapseSpace(b.String()))
	if validation.JSLength(cleaned) > subjectMax {
		return "", fmt.Errorf("subject must be at most %d characters.", subjectMax)
	}
	return cleaned, nil
}

func isTemplateKind(kind string) bool {
	for _, k := range spec().templateKinds {
		if k == kind {
			return true
		}
	}
	return false
}

// substitute copies a template block tree, replacing the prefix and subject sentinels in every string.
func substitute(v any, replacer *strings.Replacer) any {
	switch t := v.(type) {
	case string:
		return replacer.Replace(t)
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = substitute(e, replacer)
		}
		return out
	case *validation.Object:
		out := make(map[string]any, len(t.Keys))
		for _, k := range t.Keys {
			out[k] = substitute(t.Values[k], replacer)
		}
		return out
	}
	return v
}

// createTemplate returns the ordered blocks of a report template. prefix must be a valid ID prefix; subject is the
// cleaned subject ("" for the neutral wording); parentID is nil or the container that receives the top-level blocks.
func createTemplate(kind, prefix, subject string, parentID any) ([]any, error) {
	if !isTemplateKind(kind) {
		return nil, fmt.Errorf("Unknown template "+dq(kind)+". Use one of: %s.", strings.Join(spec().templateKinds, ", "))
	}
	if !templatePrefix.MatchString(prefix) {
		return nil, errors.New("idPrefix must start with a letter or digit and use only letters, digits, dot, underscore, colon and hyphen (at most 60 characters).")
	}
	entry := spec().templates[kind]
	variant := "withoutSubject"
	if subject != "" {
		variant = "withSubject"
	}
	// One pass, so a subject that happens to contain the other sentinel is not substituted twice.
	blocks := substitute(get(entry, variant), strings.NewReplacer(prefixSentinel, prefix, subjectSentinel, subject)).([]any)
	for _, b := range blocks {
		block := b.(map[string]any)
		if block["parentId"] == nil {
			block["parentId"] = parentID
		}
	}
	return blocks, nil
}

func templateTitle(kind, subject string) (string, error) {
	cleaned := ""
	if subject != "" {
		var err error
		if cleaned, err = cleanSubject(subject); err != nil {
			return "", err
		}
	}
	base := spec().templateTitles[kind]
	if cleaned == "" || kind == "blank" {
		return base, nil
	}
	return cleaned + ": " + strings.ToLower(base[:1]) + base[1:], nil
}

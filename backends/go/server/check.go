// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package server

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
	"sync"

	"github.com/Super-Solution/super-editor/backends/go/editor"
	"github.com/Super-Solution/super-editor/backends/go/render"
	"github.com/Super-Solution/super-editor/backends/go/validation"
)

// issue is the panic payload of a rejected input; run turns it into a failure result.
type issue struct{ editor.Issue }

func fail(message, path, hint string) {
	panic(issue{editor.Issue{Code: "validation", Message: message, Path: path, Hint: hint}})
}

func reject(code, message, hint string, extra editor.Issue) {
	extra.Code, extra.Message, extra.Hint = code, message, hint
	panic(issue{extra})
}

const (
	maxDepth = 40
	maxNodes = 400_000
)

// plainCopy copies untrusted JSON-like input into *validation.Object / []any / string / float64 / bool / nil, rejecting
// what JSON cannot carry (non-finite numbers, foreign types) and input that is too large or too deep.
func plainCopy(value any, path string) any {
	nodes := 0
	var walk func(v any, at string, depth int) any
	walk = func(v any, at string, depth int) any {
		nodes++
		if nodes > maxNodes {
			fail("Input is too large.", at, "Send less data per call.")
		}
		switch t := v.(type) {
		case nil, string, bool:
			return t
		case float64:
			if math.IsNaN(t) || math.IsInf(t, 0) {
				fail("Numbers must be finite.", at, "")
			}
			return t
		case int:
			return float64(t)
		case int64:
			return float64(t)
		case json.Number:
			f, _ := t.Float64()
			return f
		case []any:
			if depth > maxDepth {
				fail("Input is nested too deeply.", at, "")
			}
			if len(t) > 100_000 {
				fail("Array is too long.", at, "")
			}
			out := make([]any, len(t))
			for i, e := range t {
				out[i] = walk(e, fmt.Sprintf("%s[%d]", at, i), depth+1)
			}
			return out
		case *validation.Object:
			if depth > maxDepth {
				fail("Input is nested too deeply.", at, "")
			}
			out := &validation.Object{Keys: make([]string, 0, len(t.Keys)), Values: make(map[string]any, len(t.Keys))}
			for _, k := range t.Keys {
				out.Keys = append(out.Keys, k)
				out.Values[k] = walk(t.Values[k], at+"."+k, depth+1)
			}
			return out
		case map[string]any:
			keys := make([]string, 0, len(t))
			for k := range t {
				keys = append(keys, k)
			}
			sortStrings(keys)
			o := &validation.Object{Keys: keys, Values: t}
			return walk(o, at, depth)
		}
		fail("Only JSON values are accepted.", at, "Use null, booleans, numbers, strings, arrays and plain objects.")
		return nil
	}
	return walk(value, path, 0)
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

func typeOf(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case []any:
		return "array"
	case float64:
		if t == math.Trunc(t) {
			return "integer"
		}
		return "number"
	case string:
		return "string"
	case bool:
		return "boolean"
	}
	return "object"
}

func matchesType(expected string, v any) bool {
	actual := typeOf(v)
	return actual == expected || (expected == "number" && actual == "integer")
}

func pretty(v any) string {
	if s, ok := v.(string); ok {
		return `"` + s + `"`
	}
	raw, _ := json.Marshal(v)
	return string(raw)
}

var patterns sync.Map

func matchPattern(pattern, value string) bool {
	re, ok := patterns.Load(pattern)
	if !ok {
		re, _ = patterns.LoadOrStore(pattern, regexp.MustCompile(pattern))
	}
	return re.(*regexp.Regexp).MatchString(value)
}

func schemaNumber(o *validation.Object, key string) (float64, bool) {
	f, ok := get(o, key).(float64)
	return f, ok
}

func jsValueEqual(a, b any) bool {
	switch x := a.(type) {
	case string:
		y, ok := b.(string)
		return ok && x == y
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case nil:
		return b == nil
	}
	return false
}

// check validates value against the subset of JSON Schema the action schemas use (type, enum, const, minimum, maximum,
// minLength, maxLength, pattern, items, minItems, maxItems, uniqueItems, properties, required, additionalProperties,
// anyOf and local $ref) and panics with the first problem, like the reference.
func check(schema *validation.Object, value any, path string, root *validation.Object) {
	if ref, ok := get(schema, "$ref").(string); ok {
		defs, _ := get(root, "$defs").(*validation.Object)
		var target *validation.Object
		if defs != nil {
			target, _ = get(defs, strings.Replace(ref, "#/$defs/", "", 1)).(*validation.Object)
		}
		if target == nil {
			fail("Internal schema reference could not be resolved.", path, "")
		}
		check(target, value, path, root)
		return
	}
	if alternatives, ok := get(schema, "anyOf").([]any); ok {
		matched := false
		var first *issue
		for _, alt := range alternatives {
			func() {
				defer func() {
					if r := recover(); r != nil {
						if is, ok := r.(issue); ok {
							if first == nil {
								first = &is
							}
							return
						}
						panic(r)
					}
				}()
				check(alt.(*validation.Object), value, path, root)
				matched = true
			}()
			if matched {
				break
			}
		}
		if !matched {
			hint := str(schema, "x-hint")
			if hint == "" && first != nil {
				hint = first.Hint
				if hint == "" {
					hint = first.Message
				}
			}
			fail("The value does not match any allowed form.", path, hint)
		}
	}
	if c, ok := schema.Get("const"); ok && !jsValueEqual(value, c) {
		fail("Expected "+pretty(c)+".", path, "")
	}
	if en, ok := get(schema, "enum").([]any); ok {
		found := false
		for _, e := range en {
			if jsValueEqual(value, e) {
				found = true
				break
			}
		}
		if !found {
			parts := make([]string, len(en))
			for i, e := range en {
				parts[i] = pretty(e)
			}
			joined := strings.Join(parts, ", ")
			fail("Expected one of: "+joined+".", path, "Use one of "+joined+".")
		}
	}
	if t, ok := schema.Get("type"); ok {
		var types []string
		switch x := t.(type) {
		case string:
			types = []string{x}
		case []any:
			for _, e := range x {
				types = append(types, e.(string))
			}
		}
		okType := false
		for _, e := range types {
			if matchesType(e, value) {
				okType = true
			}
		}
		if !okType {
			fail(fmt.Sprintf("Expected %s, received %s.", strings.Join(types, " or "), typeOf(value)), path, str(schema, "description"))
		}
	}
	switch v := value.(type) {
	case string:
		length := validation.JSLength(v)
		if min, ok := schemaNumber(schema, "minLength"); ok && float64(length) < min {
			fail(fmt.Sprintf("Expected at least %s character(s).", render.JSNumber(min)), path, "")
		}
		if max, ok := schemaNumber(schema, "maxLength"); ok && float64(length) > max {
			fail(fmt.Sprintf("Expected at most %s characters (received %d).", render.JSNumber(max), length), path, "Shorten the text, or split it across several calls.")
		}
		if p, ok := get(schema, "pattern").(string); ok && !matchPattern(p, v) {
			hint := str(schema, "description")
			if hint == "" {
				hint = "It must match " + p + "."
			}
			fail("Value has an invalid format.", path, hint)
		}
	case float64:
		if min, ok := schemaNumber(schema, "minimum"); ok && v < min {
			fail(fmt.Sprintf("Expected a value of at least %s.", render.JSNumber(min)), path, "")
		}
		if max, ok := schemaNumber(schema, "maximum"); ok && v > max {
			fail(fmt.Sprintf("Expected a value of at most %s.", render.JSNumber(max)), path, "")
		}
	case []any:
		if min, ok := schemaNumber(schema, "minItems"); ok && float64(len(v)) < min {
			fail(fmt.Sprintf("Expected at least %s item(s).", render.JSNumber(min)), path, "")
		}
		if max, ok := schemaNumber(schema, "maxItems"); ok && float64(len(v)) > max {
			fail(fmt.Sprintf("Expected at most %s items (received %d).", render.JSNumber(max), len(v)), path, "Send fewer items per call.")
		}
		if u, _ := get(schema, "uniqueItems").(bool); u {
			seen := map[string]bool{}
			for _, e := range v {
				raw, _ := json.Marshal(e)
				seen[string(raw)] = true
			}
			if len(seen) != len(v) {
				fail("Items must be unique.", path, "")
			}
		}
		if items, ok := get(schema, "items").(*validation.Object); ok {
			for i, e := range v {
				check(items, e, fmt.Sprintf("%s[%d]", path, i), root)
			}
		}
	case *validation.Object:
		properties, _ := get(schema, "properties").(*validation.Object)
		if properties == nil {
			properties = &validation.Object{Values: map[string]any{}}
		}
		if required, ok := get(schema, "required").([]any); ok {
			for _, k := range required {
				key := k.(string)
				if _, has := v.Values[key]; !has {
					fail("Required property is missing.", path+"."+key, `Add "`+key+`".`)
				}
			}
		}
		for _, key := range validation.JSKeyOrder(v.Keys) {
			prop, known := properties.Get(key)
			if !known {
				if ap, ok := schema.Get("additionalProperties"); ok && ap == false {
					names := validation.JSKeyOrder(properties.Keys)
					allowed := "(none)"
					if len(names) > 0 {
						allowed = strings.Join(names, ", ")
					}
					fail("Unknown property.", path+"."+key, "Remove it. Allowed properties: "+allowed+".")
				}
				continue
			}
			check(prop.(*validation.Object), v.Values[key], path+"."+key, root)
		}
	}
}

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package validation

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"unicode/utf8"
)

// LoneSurrogateError reports text that holds half of a surrogate pair (a JSON escape such as \ud800 with no partner).
// encoding/json would swap it for U+FFFD without a word, so the text is refused instead: bad data must stay visible.
type LoneSurrogateError struct{ Offset int }

func (e *LoneSurrogateError) Error() string {
	return fmt.Sprintf("text contains an unpaired surrogate (half of a character such as an emoji) at byte %d; it is refused, not replaced", e.Offset)
}

// ErrInvalidUTF8 is returned for input that is not valid UTF-8 (a Big5 or GBK file, for example). It is never repaired.
var ErrInvalidUTF8 = errors.New("the input is not valid UTF-8; it is refused, not repaired")

func hex4(b []byte) (rune, bool) {
	if len(b) < 4 {
		return 0, false
	}
	var v rune
	for _, c := range b[:4] {
		switch {
		case c >= '0' && c <= '9':
			v = v<<4 | rune(c-'0')
		case c >= 'a' && c <= 'f':
			v = v<<4 | rune(c-'a'+10)
		case c >= 'A' && c <= 'F':
			v = v<<4 | rune(c-'A'+10)
		default:
			return 0, false
		}
	}
	return v, true
}

// checkText finds a \uXXXX escape inside a JSON string that is half of a surrogate pair. A malformed escape is left for the
// decoder to report.
func checkText(data []byte) error {
	inString := false
	for i := 0; i < len(data); i++ {
		c := data[i]
		if !inString {
			inString = c == '"'
			continue
		}
		switch c {
		case '"':
			inString = false
		case '\\':
			if i+1 >= len(data) {
				return nil
			}
			if data[i+1] != 'u' {
				i++
				continue
			}
			unit, ok := hex4(data[i+2:])
			if !ok {
				return nil
			}
			switch {
			case unit >= 0xD800 && unit <= 0xDBFF:
				if i+11 < len(data) && data[i+6] == '\\' && data[i+7] == 'u' {
					if next, ok := hex4(data[i+8:]); ok && next >= 0xDC00 && next <= 0xDFFF {
						i += 11
						continue
					}
				}
				return &LoneSurrogateError{Offset: i}
			case unit >= 0xDC00 && unit <= 0xDFFF:
				return &LoneSurrogateError{Offset: i}
			}
			i += 5
		}
	}
	return nil
}

// Object is a decoded JSON object that remembers member order. The reference validator reports the first
// unknown member in JavaScript property order, so the order is part of the contract.
type Object struct {
	Keys   []string
	Values map[string]any
}

// Get returns a member and whether it is present.
func (o *Object) Get(key string) (any, bool) {
	v, ok := o.Values[key]
	return v, ok
}

// Decode parses one JSON document into nil, bool, float64, string, []any and *Object. Numbers that overflow a
// float64 become ±Inf (as JSON.parse does), which the validators then refuse.
func Decode(data []byte) (any, error) {
	if !utf8.Valid(data) {
		return nil, ErrInvalidUTF8
	}
	if err := checkText(data); err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected data after the JSON value")
	}
	return v, nil
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			obj := &Object{Values: map[string]any{}}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key := kt.(string)
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				if _, dup := obj.Values[key]; !dup {
					obj.Keys = append(obj.Keys, key)
				}
				obj.Values[key] = v
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return obj, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil {
			var ne *strconv.NumError
			if !errors.As(err, &ne) || ne.Err != strconv.ErrRange {
				return nil, err
			}
		}
		return f, nil
	case string, bool, nil:
		return t, nil
	}
	return nil, errors.New("unexpected token")
}

// Plain converts decoded input (or validator output) into maps and slices only, for comparison and encoding.
func Plain(v any) any {
	switch t := v.(type) {
	case *Object:
		m := make(map[string]any, len(t.Values))
		for k, val := range t.Values {
			m[k] = Plain(val)
		}
		return m
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = Plain(e)
		}
		return out
	default:
		return v
	}
}

// MarshalJSON writes the members in their recorded (JavaScript property) order.
func (o *Object) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, key := range o.Keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		k, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		v, err := json.Marshal(o.Values[key])
		if err != nil {
			return nil, err
		}
		buf.Write(k)
		buf.WriteByte(':')
		buf.Write(v)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

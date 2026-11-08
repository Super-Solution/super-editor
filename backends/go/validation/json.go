// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package validation

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
)

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

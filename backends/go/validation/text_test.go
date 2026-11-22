// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package validation

import (
	"errors"
	"testing"
)

func TestDecodeRefusesUnpairedSurrogatesAndKeepsValidText(t *testing.T) {
	valid := []string{
		`"😀"`, `"😀"`, `"😀 pair"`, `"a�b"`, `"𠮷野家"`, `"back\\ud800slash"`, `"\\"`, `{"k":"é"}`,
	}
	for _, text := range valid {
		if _, err := Decode([]byte(text)); err != nil {
			t.Errorf("%s: %v", text, err)
		}
	}
	lone := []string{
		`"a\ud800b"`, `"\udc00"`, `"x\ud83d"`, `"\ude00\ud83d"`, `"ok 😀 then \ud83d"`, `{"t":"ok \ud83d\u0041"}`, `["fine", "half \udfff here"]`,
	}
	for _, text := range lone {
		_, err := Decode([]byte(text))
		var got *LoneSurrogateError
		if !errors.As(err, &got) {
			t.Errorf("%s: err = %v, want an unpaired-surrogate error", text, err)
		}
	}
	if _, err := Decode([]byte("\"\xb3\xf8\"")); !errors.Is(err, ErrInvalidUTF8) {
		t.Errorf("invalid UTF-8: err = %v", err)
	}
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/Super-Solution/super-editor/backends/go/editor"
	"github.com/Super-Solution/super-editor/backends/go/validation"
)

type serverFixture struct {
	Scenarios []struct {
		Name     string          `json:"name"`
		Document json.RawMessage `json:"document"`
		Options  struct {
			ReadOnly     bool `json:"readOnly"`
			MaxBodyBytes int64
			Actor        *struct {
				ID   string `json:"id"`
				Kind string `json:"kind"`
			} `json:"actor"`
			BasePath string `json:"basePath"`
			CORS     *struct {
				Origins json.RawMessage `json:"origins"`
				Headers []string        `json:"headers"`
				MaxAge  int             `json:"maxAge"`
			} `json:"cors"`
		} `json:"options"`
		RawOptions map[string]json.RawMessage `json:"-"`
		Steps      []struct {
			Now     string `json:"now"`
			Request struct {
				Method  string            `json:"method"`
				Path    string            `json:"path"`
				Headers map[string]string `json:"headers"`
				Body    *string           `json:"body"`
			} `json:"request"`
			Response struct {
				Status  int               `json:"status"`
				Headers map[string]string `json:"headers"`
				JSON    json.RawMessage   `json:"json"`
				Text    *string           `json:"text"`
			} `json:"response"`
		} `json:"steps"`
	} `json:"scenarios"`
}

func TestServerConformance(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "conformance", "server.v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f serverFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	var rawScenarios struct {
		Scenarios []struct {
			Options struct {
				MaxBodyBytes int64 `json:"maxBodyBytes"`
			} `json:"options"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &rawScenarios); err != nil {
		t.Fatal(err)
	}
	failures, skipped := 0, 0
	for si, sc := range f.Scenarios {
		doc, err := validation.Decode(sc.Document)
		if err != nil {
			t.Fatal(err)
		}
		clock := ""
		ed, err := editor.New(doc, editor.Options{Now: func() string { return clock }})
		if err != nil {
			t.Fatalf("%s: %v", sc.Name, err)
		}
		opts := Options{ReadOnly: sc.Options.ReadOnly, BasePath: sc.Options.BasePath, MaxBodyBytes: rawScenarios.Scenarios[si].Options.MaxBodyBytes,
			Now: func() string { return clock }}
		if a := sc.Options.Actor; a != nil {
			actor := map[string]any{"id": a.ID, "kind": a.Kind}
			opts.Actor = func(*http.Request) map[string]any { return actor }
		}
		if c := sc.Options.CORS; c != nil {
			opts.CORS = &CORS{Headers: c.Headers, MaxAge: c.MaxAge}
			var star string
			if json.Unmarshal(c.Origins, &star) == nil {
				opts.CORS.AllowAny = star == "*"
			} else {
				_ = json.Unmarshal(c.Origins, &opts.CORS.Origins)
			}
		}
		h, err := NewHandler(NewService(ed), opts)
		if err != nil {
			t.Fatalf("%s: %v", sc.Name, err)
		}
		for i, st := range sc.Steps {
			clock = st.Now
			var body io.Reader
			if st.Request.Body != nil {
				body = strings.NewReader(*st.Request.Body)
			}
			req, ok := newRequest(st.Request.Method, "http://localhost"+st.Request.Path, body)
			if !ok {
				// Go's net/http refuses a malformed percent-escape in the request line before any handler runs (it answers
				// 400 itself), so the handler is unreachable for these requests.
				skipped++
				continue
			}
			req.Host = "localhost"
			for k, v := range st.Request.Headers {
				req.Header.Set(k, v)
			}
			if st.Request.Body != nil && req.Header.Get("x-no-content-type") == "" && req.Header.Get("content-type") == "" {
				req.Header.Set("content-type", "application/json")
			} else if st.Request.Body != nil && req.Header.Get("x-no-content-type") != "" {
				// fetch labels a string body without a content type as text/plain.
				req.Header.Set("content-type", "text/plain;charset=UTF-8")
			}
			req.Header.Del("x-no-content-type")
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			label := func() string { return sc.Name + " #" + itoa(i) + " " + st.Request.Method + " " + st.Request.Path }
			bad := func(format string, args ...any) {
				failures++
				if failures <= 25 {
					t.Errorf(label()+": "+format, args...)
				}
			}
			if rec.Code != st.Response.Status {
				bad("status %d, want %d\n body %s", rec.Code, st.Response.Status, rec.Body.String())
				continue
			}
			got := map[string]string{}
			for k, v := range rec.Header() {
				got[strings.ToLower(k)] = strings.Join(v, ", ")
			}
			if !reflect.DeepEqual(got, st.Response.Headers) {
				bad("headers\n got  %v\n want %v", got, st.Response.Headers)
				continue
			}
			if st.Request.Method == "HEAD" {
				// The TS handler returns a body a real HTTP server then drops; status and headers are what a client sees.
				continue
			}
			if st.Response.JSON != nil {
				var want, have any
				_ = json.Unmarshal(st.Response.JSON, &want)
				if err := json.Unmarshal(rec.Body.Bytes(), &have); err != nil {
					bad("body not JSON: %q", rec.Body.String())
					continue
				}
				have, want = normalizeIDs(have), normalizeIDs(want)
				if !reflect.DeepEqual(have, want) {
					hb, _ := json.Marshal(have)
					bad("json\n got  %s\n want %s\n request %v", clip(hb), clip(st.Response.JSON), derefStr(st.Request.Body))
				}
			} else if st.Response.Text != nil && rec.Body.String() != *st.Response.Text {
				bad("text\n got  %q\n want %q", clip([]byte(rec.Body.String())), clip([]byte(*st.Response.Text)))
			}
		}
	}
	if skipped > 3 {
		t.Fatalf("%d requests skipped for malformed escapes", skipped)
	}
	if failures > 0 {
		t.Fatalf("%d failures", failures)
	}
}

func clip(b []byte) string {
	b = bytes.TrimSpace(b)
	if len(b) > 1500 {
		return string(b[:1500]) + "…"
	}
	return string(b)
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return clip([]byte(*s))
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func newRequest(method, target string, body io.Reader) (req *http.Request, ok bool) {
	defer func() {
		if recover() != nil {
			req, ok = nil, false
		}
	}()
	return httptest.NewRequest(method, target, body), true
}

var randomID = regexp.MustCompile(`^[a-z_]+-[0-9a-f]{16}$`)

// normalizeIDs blanks the random suffix of generated transaction ids, which differ between runs and languages.
func normalizeIDs(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, item := range x {
			if s, ok := item.(string); ok && k == "transactionId" && randomID.MatchString(s) {
				x[k] = s[:strings.LastIndex(s, "-")] + "-RANDOM"
			} else {
				x[k] = normalizeIDs(item)
			}
		}
	case []any:
		for i, item := range x {
			x[i] = normalizeIDs(item)
		}
	}
	return v
}

// TestConcurrentRequests runs reads and writes from many goroutines (go test -race checks the handler's shared state:
// the lazily built OpenAPI document, the service, the spec).
func TestConcurrentRequests(t *testing.T) {
	doc, err := validation.Decode([]byte(`{"schemaVersion":1,"id":"d","title":"T","revision":0,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","format":{"page":"screen","font":"sans","fontSize":16,"lineHeight":1.6},"blocks":[],"citations":[],"retiredBlockIds":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	ed, err := editor.New(doc, editor.Options{Now: func() string { return "2026-06-01T00:00:00.000Z" }})
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(NewService(ed), Options{Now: func() string { return "2026-06-01T00:00:00.000Z" }})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				for _, r := range []*http.Request{
					httptest.NewRequest("GET", "/openapi.json", nil),
					httptest.NewRequest("GET", "/outline", nil),
					httptest.NewRequest("POST", "/actions/set_title", strings.NewReader(`{"title":"T`+itoa(i)+`"}`)),
				} {
					r.Header.Set("content-type", "application/json")
					rec := httptest.NewRecorder()
					h.ServeHTTP(rec, r)
					if rec.Code >= 500 {
						t.Errorf("%s %s: %d %s", r.Method, r.URL.Path, rec.Code, rec.Body.String())
					}
				}
			}
		}(i)
	}
	wg.Wait()
}

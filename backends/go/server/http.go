// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Super-Solution/super-editor/backends/go/editor"
	"github.com/Super-Solution/super-editor/backends/go/validation"
)

// CORS configures cross-origin access. It is off unless set; the handler never authenticates, so only enable it behind
// your own auth.
type CORS struct {
	// AllowAny allows every origin ("*"). Otherwise Origins lists the exact origins allowed.
	AllowAny bool
	Origins  []string
	// Headers are extra request headers allowed in preflight; content-type is always allowed.
	Headers []string
	// MaxAge is how many seconds a browser may cache a preflight answer. Default 600.
	MaxAge int
}

// Options configure the HTTP handler.
type Options struct {
	// MaxBodyBytes is the largest accepted request body. Default 1 MiB.
	MaxBodyBytes int64
	// Actor derives the provenance recorded on edits from the authenticated request. When set it wins over any actor in a
	// request body; otherwise the body's actor is used, then {id: "http-client", kind: "agent"}.
	Actor func(r *http.Request) map[string]any
	// ReadOnly refuses every route that can change the document with 403.
	ReadOnly bool
	CORS     *CORS
	// BasePath is stripped before routing, for a handler mounted below a sub-path ("/api/reports/42").
	BasePath string
	// Now is the clock for timestamps the actions create (citation accessedAt).
	Now func() string
}

// problem is a request-level error raised inside route handlers.
type problem struct {
	status int
	issue  editor.Issue
}

func newProblem(status int, message, hint, path string) problem {
	return problem{status, editor.Issue{Code: "validation", Message: message, Hint: hint, Path: path}}
}

type response struct {
	status  int
	headers [][2]string
	body    []byte
}

func (r *response) set(name, value string) {
	for i, h := range r.headers {
		if h[0] == name {
			r.headers[i][1] = value
			return
		}
	}
	r.headers = append(r.headers, [2]string{name, value})
}

func (r *response) append(name, value string) {
	for i, h := range r.headers {
		if h[0] == name {
			r.headers[i][1] += ", " + value
			return
		}
	}
	r.headers = append(r.headers, [2]string{name, value})
}

func baseHeaders(contentType string) [][2]string {
	return [][2]string{{"content-type", contentType}, {"cache-control", "no-store"}, {"x-content-type-options", "nosniff"}}
}

func marshal(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		panic(err)
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

func jsonResponse(v any, status int, extra ...[2]string) *response {
	r := &response{status: status, headers: baseHeaders("application/json; charset=utf-8"), body: marshal(v)}
	for _, h := range extra {
		r.set(h[0], h[1])
	}
	return r
}

func textResponse(text, mediaType string, extra ...[2]string) *response {
	r := &response{status: 200, headers: baseHeaders(mediaType + "; charset=utf-8"), body: []byte(text)}
	for _, h := range extra {
		r.set(h[0], h[1])
	}
	return r
}

func failureResponse(s Service, issues []editor.Issue, status int, extra ...[2]string) *response {
	return jsonResponse(failure(s, issues), status, extra...)
}

func statusForIssues(issues []editor.Issue, legacy bool) int {
	has := func(code string) bool {
		for _, i := range issues {
			if i.Code == code {
				return true
			}
		}
		return false
	}
	switch {
	case has("conflict"):
		return 409
	case !legacy && (has("duplicate") || has("history")):
		return 409
	case !legacy && has("not-found"):
		return 404
	}
	return 400
}

// ---- request helpers -------------------------------------------------------------------------------------------------

var actorID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)

func readActor(v any, path string) map[string]any {
	bad := func() map[string]any {
		panic(newProblem(400, "Expected an actor: { id, kind }.", "kind is one of human, agent or system; id uses letters, digits and . _ : - .", path))
	}
	o, ok := v.(*validation.Object)
	if !ok {
		return bad()
	}
	for _, k := range o.Keys {
		if k != "id" && k != "kind" {
			return bad()
		}
	}
	id, ok := o.Values["id"].(string)
	kind, _ := o.Values["kind"].(string)
	if !ok || validation.JSLength(id) > 128 || !actorID.MatchString(id) || (kind != "human" && kind != "agent" && kind != "system") {
		return bad()
	}
	return map[string]any{"id": id, "kind": kind}
}

type request struct {
	r      *http.Request
	path   string
	query  string
	params map[string]string
	opts   *Options
	limit  int64
	raw    []byte
	read   bool
}

func (q *request) mediaType() string {
	ct := q.r.Header.Get("Content-Type")
	if ct == "" {
		return ""
	}
	first, _, _ := strings.Cut(ct, ";")
	return strings.ToLower(strings.TrimSpace(first))
}

func (q *request) bytes() []byte {
	if q.read {
		return q.raw
	}
	tooLarge := func() problem {
		return newProblem(413, fmt.Sprintf("The request body exceeds %d bytes.", q.limit), "Send less data per request: split large inserts into several calls.", "")
	}
	if cl := q.r.Header.Get("Content-Length"); cl != "" {
		n, err := strconv.ParseUint(cl, 10, 64)
		if err != nil || !allDigits(cl) || float64(n) > float64(q.limit) {
			panic(tooLarge())
		}
	}
	if q.r.Body == nil || q.r.Body == http.NoBody {
		panic(newProblem(400, "A request body is required.", "", ""))
	}
	data, err := io.ReadAll(io.LimitReader(q.r.Body, q.limit+1))
	if err != nil {
		panic(newProblem(400, "The request body could not be read.", "", ""))
	}
	if int64(len(data)) > q.limit {
		panic(tooLarge())
	}
	q.raw, q.read = data, true
	return data
}

func allDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

func (q *request) text() string {
	data := q.bytes()
	if !utf8.Valid(data) {
		panic(newProblem(400, "The request body is not valid UTF-8.", "", ""))
	}
	return strings.TrimPrefix(string(data), "\ufeff")
}

func (q *request) body() any {
	if t := q.mediaType(); t != "" && t != "application/json" {
		panic(newProblem(415, "Content-Type must be application/json.", "Send the body as JSON with Content-Type: application/json.", ""))
	}
	v, err := validation.Decode([]byte(q.text()))
	if err != nil {
		panic(newProblem(400, "The request body is not valid JSON.", "Send one JSON value.", ""))
	}
	return v
}

func (q *request) actor(supplied any, has bool) map[string]any {
	if q.opts.Actor != nil {
		return q.opts.Actor(q.r)
	}
	if !has {
		return map[string]any{"id": "http-client", "kind": "agent"}
	}
	return readActor(supplied, "body.actor")
}

func (q *request) actionContext(supplied any, has bool) Context {
	return Context{Actor: q.actor(supplied, has), Now: q.opts.Now}
}

func hexByte(s string) (byte, bool) {
	if len(s) != 2 {
		return 0, false
	}
	var v byte
	for i := 0; i < 2; i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			v = v<<4 | (c - '0')
		case c >= 'a' && c <= 'f':
			v = v<<4 | (c - 'a' + 10)
		case c >= 'A' && c <= 'F':
			v = v<<4 | (c - 'A' + 10)
		default:
			return 0, false
		}
	}
	return v, true
}

// percentDecode is decodeURIComponent.
func percentDecode(s string) (string, bool) {
	var out []byte
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			out = append(out, s[i])
			continue
		}
		if i+3 > len(s) {
			return "", false
		}
		b, ok := hexByte(s[i+1 : i+3])
		if !ok {
			return "", false
		}
		out = append(out, b)
		i += 2
	}
	if !utf8.Valid(out) {
		return "", false
	}
	return string(out), true
}

// lenientDecode decodes a query component the way URLSearchParams does: '+' is a space, bad escapes stay as they are,
// bytes that are not UTF-8 become U+FFFD.
func lenientDecode(s string) string {
	s = strings.ReplaceAll(s, "+", " ")
	var out []byte
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+3 <= len(s) {
			if b, ok := hexByte(s[i+1 : i+3]); ok {
				out = append(out, b)
				i += 2
				continue
			}
		}
		out = append(out, s[i])
	}
	return strings.ToValidUTF8(string(out), "\ufffd")
}

type pair struct{ key, value string }

func parseQueryString(raw string) []pair {
	var out []pair
	for _, part := range strings.Split(raw, "&") {
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		out = append(out, pair{lenientDecode(k), lenientDecode(v)})
	}
	return out
}

var integerValue = regexp.MustCompile(`^\d{1,15}$`)

// parseQuery turns a query string into action input following the route's parameter definitions.
func parseQuery(raw string, defs []queryParam) map[string]any {
	input := map[string]any{}
	pairs := parseQueryString(raw)
	seen := map[string]bool{}
	var keys []string
	for _, p := range pairs {
		if !seen[p.key] {
			seen[p.key] = true
			keys = append(keys, p.key)
		}
	}
	for _, key := range keys {
		var def *queryParam
		for i := range defs {
			if defs[i].Name == key {
				def = &defs[i]
				break
			}
		}
		path := "query." + key
		if def == nil {
			hint := "This route takes no query parameters."
			if len(defs) > 0 {
				names := make([]string, len(defs))
				for i, d := range defs {
					names[i] = d.Name
				}
				hint = "Allowed parameters: " + strings.Join(names, ", ") + "."
			}
			panic(newProblem(400, "Unknown query parameter "+dq(key)+".", hint, path))
		}
		var values []string
		for _, p := range pairs {
			if p.key == key {
				values = append(values, p.value)
			}
		}
		if def.Type != "list" && len(values) > 1 {
			panic(newProblem(400, "Query parameter "+dq(key)+" was given more than once.", "Send it once.", path))
		}
		value := values[0]
		switch def.Type {
		case "list":
			list := []any{}
			for _, v := range values {
				for _, e := range strings.Split(v, ",") {
					if e = jsTrim(e); e != "" {
						list = append(list, e)
					}
				}
			}
			input[def.Field] = list
		case "integer":
			if !integerValue.MatchString(value) {
				panic(newProblem(400, "Query parameter "+dq(key)+" must be a non-negative integer.", "", path))
			}
			n, _ := strconv.ParseFloat(value, 64)
			input[def.Field] = n
		case "boolean":
			switch value {
			case "true", "1":
				input[def.Field] = true
			case "false", "0":
				input[def.Field] = false
			default:
				panic(newProblem(400, "Query parameter "+dq(key)+" must be true or false.", "", path))
			}
		default:
			if def.Nullable && value == "null" {
				input[def.Field] = nil
				break
			}
			if len(def.Enum) > 0 {
				ok := false
				for _, e := range def.Enum {
					ok = ok || e == value
				}
				if !ok {
					panic(newProblem(400, "Query parameter "+dq(key)+" must be one of: "+strings.Join(def.Enum, ", ")+".", "", path))
				}
			}
			input[def.Field] = value
		}
	}
	return input
}

// ---- routing ---------------------------------------------------------------------------------------------------------

type match struct {
	route  *routeSpec
	params map[string]string
}

func splitPath(p string) []string { return strings.Split(p, "/") }

// matchRoute finds the route for a request, or the methods the path does support (for 405 and OPTIONS).
func matchRoute(method, pathname string) (*match, []string) {
	var allow []string
	segments := splitPath(pathname)
	for _, route := range spec().routes {
		template := splitPath(route.Path)
		if len(template) != len(segments) {
			continue
		}
		names := map[string]string{}
		ok := true
		for i, t := range template {
			if strings.HasPrefix(t, "{") && strings.HasSuffix(t, "}") {
				if segments[i] == "" {
					ok = false
					break
				}
				names[t[1:len(t)-1]] = segments[i]
			} else if t != segments[i] {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		if route.Method != method {
			dup := false
			for _, m := range allow {
				dup = dup || m == route.Method
			}
			if !dup {
				allow = append(allow, route.Method)
			}
			continue
		}
		params := map[string]string{}
		for k, v := range names {
			decoded, good := percentDecode(v)
			if !good {
				panic(newProblem(400, "The path contains invalid percent-encoding.", "", "path"))
			}
			params[k] = decoded
		}
		return &match{route, params}, nil
	}
	return nil, allow
}

// normalizePath applies the dot-segment rules of a URL parser to a request path.
func normalizePath(p string) string {
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	segments := strings.Split(p[1:], "/")
	var out []string
	for i, s := range segments {
		lower := strings.ToLower(s)
		switch lower {
		case ".", "%2e":
			if i == len(segments)-1 {
				out = append(out, "")
			}
		case "..", ".%2e", "%2e.", "%2e%2e":
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			if i == len(segments)-1 {
				out = append(out, "")
			}
		default:
			out = append(out, s)
		}
	}
	return "/" + strings.Join(out, "/")
}

// ---- the handler -----------------------------------------------------------------------------------------------------

var basePathPattern = regexp.MustCompile(`^/[^?#]*[^/?#]$`)

const exposedHeaders = "x-document-revision"

type apiHandler struct {
	service Service
	opts    Options
	limit   int64
	openapi []byte
}

// NewHandler returns the HTTP API over a service. It binds no port and authenticates nobody: the host does, before
// forwarding a request. Every failure has the same JSON shape {ok: false, issues: [{code, message, path?, hint}],
// currentRevision}.
func NewHandler(service Service, opts Options) (http.Handler, error) {
	limitBytes := opts.MaxBodyBytes
	if limitBytes == 0 {
		limitBytes = int64(spec().limits["requestBytes"])
	}
	if limitBytes < 1 {
		return nil, errors.New("MaxBodyBytes must be a positive integer")
	}
	if opts.BasePath != "" && !basePathPattern.MatchString(opts.BasePath) {
		return nil, errors.New(`BasePath must start with "/" and must not end with "/"`)
	}
	if opts.CORS != nil && !opts.CORS.AllowAny {
		for _, o := range opts.CORS.Origins {
			if o == "" || o == "*" || strings.HasSuffix(o, "/") {
				return nil, errors.New(`CORS origins must be "*" or exact origins such as "https://app.example.com"`)
			}
		}
	}
	return &apiHandler{service: service, opts: opts, limit: limitBytes}, nil
}

func (h *apiHandler) allowedOrigin(origin string, has bool) (string, bool) {
	c := h.opts.CORS
	if c == nil || !has {
		return "", false
	}
	if c.AllowAny {
		return "*", true
	}
	for _, o := range c.Origins {
		if o == origin {
			return origin, true
		}
	}
	return "", false
}

func (h *apiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	resp := h.handle(r)
	for _, hd := range resp.headers {
		w.Header().Set(hd[0], hd[1])
	}
	w.WriteHeader(resp.status)
	if r.Method != http.MethodHead {
		_, _ = w.Write(resp.body)
	}
}

func (h *apiHandler) handle(r *http.Request) (resp *response) {
	origin := r.Header.Get("Origin")
	_, hasOrigin := r.Header["Origin"]
	allowed, isAllowed := h.allowedOrigin(origin, hasOrigin)
	decorate := func(rs *response) *response {
		if isAllowed {
			rs.set("access-control-allow-origin", allowed)
			rs.set("access-control-expose-headers", exposedHeaders)
			if allowed != "*" {
				rs.append("vary", "origin")
			}
		}
		return rs
	}
	defer func() {
		if rec := recover(); rec != nil {
			if p, ok := rec.(problem); ok {
				resp = decorate(failureResponse(h.service, []editor.Issue{p.issue}, p.status))
				return
			}
			resp = decorate(failureResponse(h.service, []editor.Issue{{Code: "validation", Message: "The request could not be processed safely.", Hint: "Retry; if it keeps failing, report it with the route and body."}}, 500))
		}
	}()
	pathname := normalizePath(r.URL.EscapedPath())
	if h.opts.BasePath != "" {
		if pathname != h.opts.BasePath && !strings.HasPrefix(pathname, h.opts.BasePath+"/") {
			return decorate(failureResponse(h.service, []editor.Issue{{Code: "not-found", Message: "Unknown route.", Hint: "Routes live under " + h.opts.BasePath + "."}}, 404))
		}
		pathname = pathname[len(h.opts.BasePath):]
		if pathname == "" {
			pathname = "/"
		}
	}
	method := r.Method
	lookup := method
	if method == http.MethodHead {
		lookup = http.MethodGet
	}
	found, allow := matchRoute(lookup, pathname)
	unknown := func() *response {
		return decorate(failureResponse(h.service, []editor.Issue{{Code: "not-found", Message: "Unknown route.", Hint: "GET /openapi.json lists the routes."}}, 404))
	}

	if method == http.MethodOptions {
		if len(allow) == 0 {
			return unknown()
		}
		allowHeader := strings.Join(append(append([]string{}, allow...), "OPTIONS"), ", ")
		if _, preflight := r.Header["Access-Control-Request-Method"]; preflight && hasOrigin && h.opts.CORS != nil {
			if !isAllowed {
				return failureResponse(h.service, []editor.Issue{{Code: "validation", Message: "This origin is not allowed.", Hint: "Ask the operator to add the origin to the CORS allow-list."}}, 403)
			}
			maxAge := h.opts.CORS.MaxAge
			if maxAge == 0 {
				maxAge = 600
			}
			rs := &response{status: 204, headers: [][2]string{{"allow", allowHeader}, {"access-control-allow-origin", allowed}, {"access-control-allow-methods", allowHeader}, {"access-control-max-age", strconv.Itoa(maxAge)}, {"cache-control", "no-store"}}}
			if _, requested := r.Header["Access-Control-Request-Headers"]; requested && len(h.opts.CORS.Headers) > 0 {
				rs.set("access-control-allow-headers", strings.Join(append([]string{"content-type"}, h.opts.CORS.Headers...), ", "))
			} else {
				rs.set("access-control-allow-headers", "content-type")
			}
			if allowed != "*" {
				rs.append("vary", "origin")
			}
			return rs
		}
		return decorate(&response{status: 204, headers: [][2]string{{"allow", allowHeader}, {"cache-control", "no-store"}}})
	}
	if found == nil && len(allow) == 0 {
		return unknown()
	}
	if found == nil {
		return decorate(failureResponse(h.service, []editor.Issue{{Code: "validation", Message: "Method " + method + " is not allowed here.", Hint: "Use " + strings.Join(allow, " or ") + "."}}, 405, [2]string{"allow", strings.Join(allow, ", ")}))
	}
	route := found.route
	if h.opts.ReadOnly && route.Write {
		return decorate(failureResponse(h.service, []editor.Issue{{Code: "validation", Message: "This endpoint is read-only.", Hint: "Use a GET route, or ask the operator for a writable endpoint."}}, 403))
	}
	req := &request{r: r, path: pathname, query: r.URL.RawQuery, params: found.params, opts: &h.opts, limit: h.limit}
	rs := h.run(route, req)
	if method == http.MethodHead {
		rs = &response{status: rs.status, headers: rs.headers}
	}
	return decorate(rs)
}

func (h *apiHandler) respondAction(result map[string]any, legacy bool) *response {
	if result["ok"] == true {
		return jsonResponse(result, 200)
	}
	issues, _ := result["issues"].([]editor.Issue)
	return failureResponse(h.service, issues, statusForIssues(issues, legacy))
}

func (h *apiHandler) action(name string, input any, ctx Context) map[string]any {
	return RunAction(h.service, name, input, ctx)
}

func splitBody(body any) (input *validation.Object, actor any, hasActor bool) {
	o := body.(*validation.Object)
	input = &validation.Object{Values: map[string]any{}}
	for _, k := range o.Keys {
		if k == "actor" {
			actor, hasActor = o.Values[k], true
			continue
		}
		input.Keys = append(input.Keys, k)
		input.Values[k] = o.Values[k]
	}
	return
}

func (h *apiHandler) run(route *routeSpec, q *request) *response {
	s := h.service
	switch route.OperationID {
	case "read_document":
		return jsonResponse(s.Read(), 200)
	case "apply_transaction":
		result := s.Apply(q.body())
		return h.applyResponse(result)
	case "undo", "redo":
		body := q.body()
		o, ok := body.(*validation.Object)
		if ok {
			for _, k := range o.Keys {
				if k != "actor" && k != "expectedRevision" {
					ok = false
				}
			}
		}
		if !ok {
			return failureResponse(s, []editor.Issue{{Code: "validation", Message: "History request requires only actor and expectedRevision."}}, 400)
		}
		var result editor.Result
		if route.OperationID == "undo" {
			result = s.Undo(o.Values["actor"], o.Values["expectedRevision"])
		} else {
			result = s.Redo(o.Values["actor"], o.Values["expectedRevision"])
		}
		return h.applyResponse(result)
	case "get_outline", "find_blocks", "get_block", "document_stats", "list_revisions":
		input := parseQuery(q.query, route.Query)
		if route.OperationID == "get_block" {
			input["blockId"] = q.params["id"]
		}
		return h.respondAction(h.action(route.OperationID, input, q.actionContext(nil, false)), false)
	case "export_markdown", "export_html", "export_text":
		input := parseQuery(q.query, route.Query)
		if route.OperationID == "export_html" {
			if _, ok := input["standalone"]; !ok {
				input["standalone"] = true
			}
		}
		result := h.action(route.OperationID, input, q.actionContext(nil, false))
		if result["ok"] != true {
			issues, _ := result["issues"].([]editor.Issue)
			return failureResponse(s, issues, statusForIssues(issues, false))
		}
		mediaType := map[string]string{"export_markdown": "text/markdown", "export_html": "text/html", "export_text": "text/plain"}[route.OperationID]
		extra := [][2]string{{"x-document-revision", render0(result["revision"])}}
		if mediaType == "text/html" {
			extra = append(extra, [2]string{"content-security-policy", "default-src 'none'; img-src https:; style-src 'unsafe-inline'; sandbox"})
		}
		return textResponse(result["text"].(string), mediaType, extra...)
	case "import_markdown":
		return h.importMarkdown(route, q)
	case "list_templates":
		return h.respondAction(h.action("list_templates", &validation.Object{Values: map[string]any{}}, q.actionContext(nil, false)), false)
	case "preview_template":
		return h.previewTemplate(q, route)
	case "list_actions":
		actions := make([]any, len(spec().actions))
		for i, a := range spec().actions {
			o := &validation.Object{Values: map[string]any{}}
			for _, k := range []string{"name", "title", "description", "access", "destructive", "idempotent", "inputSchema"} {
				o.Keys = append(o.Keys, k)
				o.Values[k] = a.Raw.Values[k]
			}
			actions[i] = o
		}
		return jsonResponse(map[string]any{"ok": true, "revision": revisionOf(s), "actions": actions}, 200)
	case "run_action":
		return h.runAction(q)
	case "openapi":
		if h.openapi == nil {
			h.openapi = marshal(h.openapiDocument())
		}
		return &response{status: 200, headers: baseHeaders("application/json; charset=utf-8"), body: h.openapi}
	case "document_schema":
		return jsonResponse(spec().documentSchema, 200)
	case "transaction_schema":
		return jsonResponse(spec().txSchema, 200)
	case "health":
		return jsonResponse(map[string]any{"ok": true, "revision": revisionOf(s)}, 200)
	}
	return failureResponse(s, []editor.Issue{{Code: "not-found", Message: "Unknown route.", Hint: "GET /openapi.json lists the routes."}}, 404)
}

func render0(v any) string {
	f, _ := v.(float64)
	return strconv.FormatFloat(f, 'f', -1, 64)
}

func (h *apiHandler) applyResponse(result editor.Result) *response {
	if result.OK {
		out := map[string]any{"ok": true, "document": result.Document, "revision": result.Revision}
		if result.Duplicate {
			out["duplicate"] = true
		}
		return jsonResponse(out, 200)
	}
	return failureResponse(h.service, result.Issues, statusForIssues(result.Issues, true))
}

func (h *apiHandler) openapiDocument() *validation.Object {
	src := spec().openapi
	if h.opts.BasePath == "" {
		return src
	}
	out := &validation.Object{Values: map[string]any{}}
	for _, k := range src.Keys {
		out.Keys = append(out.Keys, k)
		out.Values[k] = src.Values[k]
		if k == "info" {
			out.Keys = append(out.Keys, "servers")
			out.Values["servers"] = []any{&validation.Object{Keys: []string{"url"}, Values: map[string]any{"url": h.opts.BasePath}}}
		}
	}
	return out
}

func (h *apiHandler) runAction(q *request) *response {
	s := h.service
	name := q.params["name"]
	action, ok := spec().actionByName[name]
	if !ok {
		names := make([]string, len(spec().actions))
		for i, a := range spec().actions {
			names[i] = a.Name
		}
		return failureResponse(s, []editor.Issue{{Code: "not-found", Message: "Unknown action " + dq(name) + ".", Hint: "GET /actions lists them: " + strings.Join(names, ", ") + "."}}, 404)
	}
	if h.opts.ReadOnly && action.Access == "write" {
		return failureResponse(s, []editor.Issue{{Code: "validation", Message: "This endpoint is read-only; " + dq(name) + " can change the document.", Hint: "Use a read action, or ask the operator for a writable endpoint."}}, 403)
	}
	body := q.body()
	if _, ok := body.(*validation.Object); !ok {
		panic(newProblem(400, "Expected a JSON object with the action input.", "", "body"))
	}
	input, supplied, hasActor := splitBody(body)
	return h.respondAction(h.action(name, input, q.actionContext(supplied, hasActor)), false)
}

func (h *apiHandler) importMarkdown(route *routeSpec, q *request) *response {
	if t := q.mediaType(); t == "text/markdown" || t == "text/plain" {
		input := parseQuery(q.query, route.Query)
		var supplied any
		hasActor := false
		if a, ok := input["actor"]; ok {
			id, kind, _ := strings.Cut(a.(string), ":")
			if kind == "" {
				kind = "agent"
			} else if i := strings.Index(kind, ":"); i >= 0 {
				kind = kind[:i]
			}
			supplied = &validation.Object{Keys: []string{"id", "kind"}, Values: map[string]any{"id": id, "kind": kind}}
			hasActor = true
			delete(input, "actor")
		}
		input["markdown"] = q.text()
		return h.respondAction(h.action("import_markdown", input, q.actionContext(supplied, hasActor)), false)
	}
	body := q.body()
	if _, ok := body.(*validation.Object); !ok {
		panic(newProblem(400, "Expected a JSON object.", `Send { "markdown": "..." }, or raw markdown with Content-Type text/markdown.`, ""))
	}
	input, supplied, hasActor := splitBody(body)
	return h.respondAction(h.action("import_markdown", input, q.actionContext(supplied, hasActor)), false)
}

func (h *apiHandler) previewTemplate(q *request, route *routeSpec) *response {
	s := h.service
	kind := q.params["kind"]
	if !isTemplateKind(kind) {
		return failureResponse(s, []editor.Issue{{Code: "not-found", Message: "Unknown template " + dq(kind) + ".", Hint: "Use one of: " + strings.Join(spec().templateKinds, ", ") + "."}}, 404)
	}
	input := parseQuery(q.query, route.Query)
	prefix := kind
	if p, ok := input["idPrefix"].(string); ok {
		prefix = p
	}
	subjectRaw, _ := input["subject"].(string)
	subject, err := cleanSubject(subjectRaw)
	var blocks []any
	if err == nil {
		blocks, err = createTemplate(kind, prefix, subject, nil)
	}
	var title string
	if err == nil {
		title, err = templateTitle(kind, subjectRaw)
	}
	if err != nil {
		panic(newProblem(400, err.Error(), "", ""))
	}
	return jsonResponse(map[string]any{"ok": true, "revision": revisionOf(s), "kind": kind, "title": title, "blocks": blocks}, 200)
}

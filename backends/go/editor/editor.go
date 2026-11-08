// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

// Package editor is the session editor of the Super Editor core: guarded transactions over the full document
// model (all 17 block types, nested sections and toggles), the 14 operations, rebase-safe stale transactions,
// undo and redo, and the revision log. It is a port of packages/core/src/editor.ts and reproduces every case of
// conformance/editor.v1.json.
//
// Documents and transactions are the generic values of package validation (maps, slices, float64 numbers,
// strings). Every input is validated first; the result documents are validated again before they commit.
// Results share structure with the editor's snapshot and must not be modified by callers.
package editor

import (
	"encoding/json"
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/Super-Solution/super-editor/backends/go/validation"
)

type record = map[string]any

const maxSafe = 9007199254740991.0

// Issue is one reason a transaction or history request was refused.
type Issue struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Path    string `json:"path,omitempty"`
	BlockID string `json:"blockId,omitempty"`
	Hint    string `json:"hint,omitempty"`
}

// Result is the outcome of Apply, Undo or Redo.
type Result struct {
	OK bool
	// Document and Revision are set on success. Duplicate marks an idempotent retry of the last transaction.
	Document  map[string]any
	Revision  map[string]any
	Duplicate bool
	// Issues and CurrentRevision are set on a refusal.
	Issues          []Issue
	CurrentRevision float64
}

// Options configure an editor. Now is the clock (ISO UTC timestamps); HistoryLimit is the number of undo steps
// kept (nil means 100, 0 disables history).
type Options struct {
	Now          func() string
	HistoryLimit *int
}

type rejected struct{ issue Issue }

func reject(code, message, blockID, hint string) {
	panic(rejected{Issue{Code: code, Message: message, BlockID: blockID, Hint: hint}})
}

func increment(value float64, label string) float64 {
	if value >= maxSafe {
		reject("conflict", label+" has reached the maximum supported version.", "", "")
	}
	return value + 1
}

func defaultHint(i Issue) string {
	switch i.Code {
	case "validation":
		if i.Path != "" {
			return fmt.Sprintf(`Compare "%s" with the JSON schemas (documentSchema, transactionSchema) and the limits in LIMITS.`, i.Path)
		}
		return "Compare the input with the JSON schemas (documentSchema, transactionSchema) and the limits in LIMITS."
	case "conflict":
		return "Re-read the document, then rebuild the transaction from its current revision and block versions. Do not retry by removing the guards."
	case "not-found":
		return "The block or citation does not exist (any more) or its ID is misspelled. Read the document to list current IDs."
	case "duplicate":
		return "Choose a different ID. IDs of deleted blocks and of already used transactions stay reserved."
	case "history":
		return "Undo and redo only cover edits made in this editor session and need the current document revision."
	}
	return ""
}

func withHints(issues []Issue) []Issue {
	out := make([]Issue, len(issues))
	for i, issue := range issues {
		if issue.Hint == "" {
			issue.Hint = defaultHint(issue)
		}
		out[i] = issue
	}
	return out
}

func fromValidation(issues []validation.Issue) []Issue {
	out := make([]Issue, len(issues))
	for i, is := range issues {
		out[i] = Issue{Code: is.Code, Message: is.Message, Path: is.Path, Hint: is.Hint}
	}
	return out
}

// ---- values ----------------------------------------------------------------------------------------------------

func clone(v any) any {
	switch t := v.(type) {
	case record:
		out := make(record, len(t))
		for k, val := range t {
			out[k] = clone(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = clone(val)
		}
		return out
	case *validation.Object:
		out := &validation.Object{Keys: append([]string(nil), t.Keys...), Values: make(map[string]any, len(t.Values))}
		for k, val := range t.Values {
			out.Values[k] = clone(val)
		}
		return out
	}
	return v
}

func cloneRecord(r record) record { return clone(r).(record) }

func strOf(r record, key string) string { s, _ := r[key].(string); return s }

func numOf(r record, key string) float64 { f, _ := r[key].(float64); return f }

func isContainer(content record) bool {
	t := content["type"]
	return t == "section" || t == "toggle"
}

func stringsOf(v any) []string {
	items, _ := v.([]any)
	out := make([]string, len(items))
	for i, item := range items {
		out[i], _ = item.(string)
	}
	return out
}

func anyStrings(items []string) []any {
	out := make([]any, len(items))
	for i, item := range items {
		out[i] = item
	}
	return out
}

func contains(items []string, s string) bool {
	for _, item := range items {
		if item == s {
			return true
		}
	}
	return false
}

// ---- document drafts ---------------------------------------------------------------------------------------------

// draft is a mutable working copy of a document: the blocks as a slice, in pre-order.
type draft struct {
	doc       record
	blocks    []record
	citations []record
	retired   []string
}

func newDraft(doc record) *draft {
	c := cloneRecord(doc)
	d := &draft{doc: c, retired: stringsOf(c["retiredBlockIds"])}
	for _, b := range c["blocks"].([]any) {
		d.blocks = append(d.blocks, b.(record))
	}
	for _, ci := range c["citations"].([]any) {
		d.citations = append(d.citations, ci.(record))
	}
	return d
}

func (d *draft) record() record {
	blocks := make([]any, len(d.blocks))
	for i, b := range d.blocks {
		blocks[i] = b
	}
	citations := make([]any, len(d.citations))
	for i, c := range d.citations {
		citations[i] = c
	}
	out := shallow(d.doc)
	out["blocks"] = blocks
	out["citations"] = citations
	out["retiredBlockIds"] = anyStrings(d.retired)
	return out
}

func (d *draft) indexOf(id string) int {
	for i, b := range d.blocks {
		if b["id"] == id {
			return i
		}
	}
	return -1
}

func (d *draft) find(id string) record {
	if i := d.indexOf(id); i >= 0 {
		return d.blocks[i]
	}
	return nil
}

// subtreeEnd is the index just past a block's contiguous descendants (documents are normally kept in pre-order).
func (d *draft) subtreeEnd(index int) int {
	members := map[string]bool{d.blocks[index]["id"].(string): true}
	end := index + 1
	for end < len(d.blocks) {
		parent, ok := d.blocks[end]["parentId"].(string)
		if !ok || !members[parent] {
			break
		}
		members[d.blocks[end]["id"].(string)] = true
		end++
	}
	return end
}

func (d *draft) subtreeIDs(roots []string) map[string]bool {
	found := map[string]bool{}
	for _, r := range roots {
		found[r] = true
	}
	children := map[string][]string{}
	for _, b := range d.blocks {
		if p, ok := b["parentId"].(string); ok {
			children[p] = append(children[p], b["id"].(string))
		}
	}
	queue := append([]string(nil), roots...)
	for i := 0; i < len(queue); i++ {
		for _, child := range children[queue[i]] {
			if !found[child] {
				found[child] = true
				queue = append(queue, child)
			}
		}
	}
	return found
}

// anchor is an ordering anchor: unset (append), null (prepend) or a sibling's ID.
type anchor struct {
	set  bool
	null bool
	id   string
}

var unset = anchor{}

func after(id string) anchor { return anchor{set: true, id: id} }

func anchorOf(op record) anchor {
	v, ok := op["afterId"]
	if !ok {
		return unset
	}
	if s, isString := v.(string); isString {
		return after(s)
	}
	return anchor{set: true, null: true}
}

func parentID(b record) (string, bool) {
	s, ok := b["parentId"].(string)
	return s, ok
}

func (d *draft) parentExists(parent any) {
	id, ok := parent.(string)
	if !ok {
		return
	}
	found := d.find(id)
	if found == nil || !isContainer(found["content"].(record)) {
		hint := fmt.Sprintf(`No block "%s" exists. Insert the section or toggle first (earlier in the same batch is fine) or use parentId: null.`, id)
		if found != nil {
			hint = fmt.Sprintf(`Block "%s" is a %s; only section and toggle blocks can contain other blocks.`, id, found["content"].(record)["type"])
		}
		reject("validation", "Parent must reference an existing section or toggle.", id, hint)
	}
}

func sameParent(b record, parent any) bool { return b["parentId"] == parent }

// put places a block among its siblings: after the subtree of its predecessor, or right after its parent when it
// is the first child. Placement is best-effort pre-order.
func (d *draft) put(block record, at anchor) {
	d.parentExists(block["parentId"])
	id := block["id"].(string)
	if at.set && !at.null && at.id == id {
		reject("validation", "A block cannot anchor itself.", id, "")
	}
	firstChild := func() int {
		if block["parentId"] == nil {
			return len(d.blocks)
		}
		return d.indexOf(block["parentId"].(string)) + 1
	}
	position := len(d.blocks)
	switch {
	case at.set && at.null:
		first := -1
		for i, b := range d.blocks {
			if sameParent(b, block["parentId"]) {
				first = i
				break
			}
		}
		if first != -1 {
			position = first
		} else {
			position = firstChild()
		}
	case at.set:
		idx := d.indexOf(at.id)
		if idx == -1 || !sameParent(d.blocks[idx], block["parentId"]) {
			where := "the document root"
			if p, ok := block["parentId"].(string); ok {
				where = `"` + p + `"`
			}
			reject("validation", "Ordering anchor must reference a sibling in the destination section.", id,
				fmt.Sprintf(`afterId "%s" must be a direct child of %s. Omit afterId to append, or use null to prepend.`, at.id, where))
		}
		position = d.subtreeEnd(idx)
	default:
		last := -1
		for i := len(d.blocks) - 1; i >= 0; i-- {
			if sameParent(d.blocks[i], block["parentId"]) {
				last = i
				break
			}
		}
		if last != -1 {
			position = d.subtreeEnd(last)
		} else {
			position = firstChild()
		}
	}
	d.blocks = append(d.blocks, nil)
	copy(d.blocks[position+1:], d.blocks[position:])
	d.blocks[position] = block
}

// relocate detaches a block with its contiguous descendants, then reinserts the run at the new position.
func (d *draft) relocate(block record, parent any, at anchor) {
	index := d.indexOf(block["id"].(string))
	end := d.subtreeEnd(index)
	run := append([]record(nil), d.blocks[index:end]...)
	d.blocks = append(d.blocks[:index], d.blocks[end:]...)
	block["parentId"] = parent
	d.put(block, at)
	at2 := d.indexOf(block["id"].(string)) + 1
	rest := append([]record(nil), d.blocks[at2:]...)
	d.blocks = append(append(d.blocks[:at2], run[1:]...), rest...)
}

func (d *draft) remove(ids map[string]bool, highWater map[string]float64, at string) {
	retired := map[string]bool{}
	for _, r := range d.retired {
		retired[r] = true
	}
	for _, b := range d.blocks {
		id := b["id"].(string)
		if ids[id] {
			tick(b, highWater, at)
			if !retired[id] {
				retired[id] = true
				d.retired = append(d.retired, id)
			}
		}
	}
	kept := d.blocks[:0:0]
	for _, b := range d.blocks {
		if !ids[b["id"].(string)] {
			kept = append(kept, b)
		}
	}
	d.blocks = kept
}

func tick(b record, highWater map[string]float64, at string) {
	id := b["id"].(string)
	v := increment(math.Max(numOf(b, "version"), highWater[id]), "Block "+id)
	b["version"] = v
	b["updatedAt"] = at
	highWater[id] = v
}

func (d *draft) blockAt(id string, expected float64) record {
	b := d.find(id)
	if b == nil {
		reject("not-found", "Block does not exist.", id, "Read the document to list current block IDs. Deleted IDs no longer exist.")
	}
	if numOf(b, "version") != expected {
		v := numOf(b, "version")
		reject("conflict", "Block changed; re-read before proposing another edit.", id,
			fmt.Sprintf(`Block "%s" is now at version %s (you sent %s). Re-read it and retry with expectedVersion %s if your edit still applies.`, id, num(v), num(expected), num(v)))
	}
	return b
}

// num formats an integer the way JavaScript prints it.
func num(f float64) string { return fmt.Sprintf("%.0f", f) }

// ---- the editor ----------------------------------------------------------------------------------------------------

type historyEntry struct {
	before, after record
}

type applied struct {
	id          string
	fingerprint string
	document    record
	revision    record
}

// Editor is one document session. It is safe for concurrent use; commits are serialized.
type Editor struct {
	mu           sync.Mutex
	now          func() string
	historyLimit int
	snapshot     record
	versions     map[string]float64
	reserved     map[string]bool
	seen         map[string]bool
	undoStack    []historyEntry
	redoStack    []historyEntry
	revisions    []record
	lastApply    *applied
}

func nowISO() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func readOptions(o Options) (func() string, int, error) {
	now := o.Now
	if now == nil {
		now = nowISO
	}
	limit := 100
	if o.HistoryLimit != nil {
		limit = *o.HistoryLimit
	}
	if limit < 0 || limit > 1000 {
		return nil, 0, fmt.Errorf("historyLimit must be an integer between 0 and 1,000")
	}
	return now, limit, nil
}

// CreateDocument returns an empty, valid document with the default format at revision 0.
func CreateDocument(id, title string, o Options) (map[string]any, error) {
	now, _, err := readOptions(o)
	if err != nil {
		return nil, err
	}
	ts := validation.Timestamp(now())
	if !ts.OK {
		return nil, fmt.Errorf("options.now: %s", ts.Issues[0].Message)
	}
	at := ts.Value.(string)
	res := validation.ValidateDocument(record{"schemaVersion": 1.0, "id": id, "title": title, "revision": 0.0, "createdAt": at, "updatedAt": at,
		"format": record{"page": "screen", "font": "sans", "fontSize": 16.0, "lineHeight": 1.6}, "blocks": []any{}, "citations": []any{}, "retiredBlockIds": []any{}})
	if !res.OK {
		return nil, fmt.Errorf("%s", res.Issues[0].Message)
	}
	return res.Value.(record), nil
}

// New creates an editor over a document. The document is validated; an invalid document is an error.
func New(document any, o Options) (*Editor, error) {
	res := validation.ValidateDocument(document)
	if !res.OK {
		return nil, fmt.Errorf("invalid document: %s (%s)", res.Issues[0].Message, res.Issues[0].Path)
	}
	now, limit, err := readOptions(o)
	if err != nil {
		return nil, err
	}
	e := &Editor{now: now, historyLimit: limit, seen: map[string]bool{}, reserved: map[string]bool{}}
	e.snapshot = res.Value.(record)
	e.versions = map[string]float64{}
	for _, b := range e.snapshot["blocks"].([]any) {
		e.versions[b.(record)["id"].(string)] = numOf(b.(record), "version")
		e.reserved[b.(record)["id"].(string)] = true
	}
	for _, id := range stringsOf(e.snapshot["retiredBlockIds"]) {
		e.reserved[id] = true
	}
	return e, nil
}

// Snapshot is the current document. Callers must not modify it.
func (e *Editor) Snapshot() map[string]any {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.snapshot
}

// Revisions is the revision log (the most recent max(1, historyLimit) entries).
func (e *Editor) Revisions() []map[string]any {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]map[string]any(nil), e.revisions...)
}

func (e *Editor) failure(issues []Issue) Result {
	return Result{Issues: withHints(issues), CurrentRevision: numOf(e.snapshot, "revision")}
}

func (e *Editor) clock() string {
	raw := e.now()
	res := validation.Timestamp(raw)
	if !res.OK {
		reject("validation", "Clock must return a valid ISO UTC timestamp.", "", "")
	}
	at := res.Value.(string)
	if validation.TimestampMillis(at) < validation.TimestampMillis(strOf(e.snapshot, "updatedAt")) {
		reject("validation", "Clock cannot move backward relative to the current document.", "", "")
	}
	return at
}

func (e *Editor) commit(next, revision record, versions map[string]float64) {
	e.snapshot = next
	e.versions = versions
	for _, b := range next["blocks"].([]any) {
		e.reserved[b.(record)["id"].(string)] = true
	}
	for _, id := range stringsOf(next["retiredBlockIds"]) {
		e.reserved[id] = true
	}
	e.revisions = append(e.revisions, revision)
	keep := e.historyLimit
	if keep < 1 {
		keep = 1
	}
	if len(e.revisions) > keep {
		e.revisions = e.revisions[len(e.revisions)-keep:]
	}
}

func (e *Editor) successResult(next, revision record) Result {
	return Result{OK: true, Document: next, Revision: revision}
}

func lastN(stack []historyEntry, n int) []historyEntry {
	if n > 0 && len(stack) > n {
		return stack[len(stack)-n:]
	}
	return stack
}

// Apply validates and applies one transaction atomically.
func (e *Editor) Apply(value any) Result {
	e.mu.Lock()
	defer e.mu.Unlock()
	res := validation.ValidateTransaction(value)
	if !res.OK {
		return e.failure(fromValidation(res.Issues))
	}
	tx := res.Value.(record)
	raw, _ := json.Marshal(tx)
	fingerprint := string(raw)
	txID := tx["id"].(string)
	if e.seen[txID] {
		if e.lastApply != nil && e.lastApply.id == txID && e.lastApply.fingerprint == fingerprint {
			return Result{OK: true, Document: e.lastApply.document, Revision: e.lastApply.revision, Duplicate: true}
		}
		return e.failure([]Issue{{Code: "duplicate", Message: "Transaction ID is consumed. Only an identical retry of the immediately preceding successful transaction is allowed."}})
	}
	if len(e.seen) >= 100_000 {
		return e.failure([]Issue{{Code: "history", Message: "Session transaction limit reached. Persist and reload the document to start a new session."}})
	}
	out, issues := guard("Transaction could not be applied safely.", func() (Result, []Issue) { return e.applyLocked(tx, fingerprint) })
	if issues != nil {
		return e.failure(issues)
	}
	return out
}

// guard runs a commit step, turning a rejection (or an unexpected failure) into issues.
func guard(fallback string, step func() (Result, []Issue)) (out Result, issues []Issue) {
	defer func() {
		if r := recover(); r != nil {
			if rj, ok := r.(rejected); ok {
				issues = []Issue{rj.issue}
				return
			}
			issues = []Issue{{Code: "validation", Message: fallback}}
		}
	}()
	return step()
}

func (e *Editor) applyLocked(tx record, fingerprint string) (Result, []Issue) {
	ops := tx["operations"].([]any)
	base := numOf(tx, "baseRevision")
	current := numOf(e.snapshot, "revision")
	stale := base != current
	if stale {
		rebasable := tx["conflictPolicy"] == "rebase-safe"
		for _, o := range ops {
			if t := o.(record)["type"]; t != "updateBlock" && t != "replaceText" {
				rebasable = false
			}
		}
		if base > current || !rebasable {
			hint := fmt.Sprintf(`The document is at revision %s (you sent %s). Re-read it and retry with baseRevision %s. conflictPolicy "rebase-safe" only carries version-guarded updateBlock and replaceText operations over a stale revision.`, num(current), num(base), num(current))
			if base > current {
				hint = fmt.Sprintf("baseRevision %s is ahead of the document (revision %s).", num(base), num(current))
			}
			reject("conflict", "Document changed; re-read before proposing another edit.", "", hint)
		}
		for _, o := range ops {
			op := o.(record)
			if op["type"] != "updateBlock" {
				continue
			}
			var existing record
			for _, b := range e.snapshot["blocks"].([]any) {
				if b.(record)["id"] == op["blockId"] {
					existing = b.(record)
				}
			}
			if existing == nil || existing["content"].(record)["type"] != op["content"].(record)["type"] {
				reject("conflict", "Rebased updates must preserve the block content type.", op["blockId"].(string), "Re-read the block and propose the change against the current document revision.")
			}
		}
	}
	at := e.clock()
	next := newDraft(e.snapshot)
	highWater := make(map[string]float64, len(e.versions))
	for k, v := range e.versions {
		highWater[k] = v
	}
	pending := make(map[string]bool, len(e.reserved))
	for k := range e.reserved {
		pending[k] = true
	}
	for _, o := range ops {
		applyOperation(next, o.(record), highWater, at, pending)
	}
	rec := next.record()
	rec["revision"] = increment(current, "Document")
	rec["updatedAt"] = at
	final := validation.ValidateDocument(rec)
	if !final.OK {
		return Result{}, fromValidation(final.Issues)
	}
	revision := record{"number": rec["revision"], "transactionId": tx["id"], "actor": clone(tx["actor"]), "at": at, "kind": "apply", "operations": clone(tx["operations"])}
	if stale {
		revision["rebasedFrom"] = base
	}
	before := e.snapshot
	e.commit(final.Value.(record), revision, highWater)
	if e.historyLimit > 0 {
		e.undoStack = lastN(append(e.undoStack, historyEntry{before: before, after: e.snapshot}), e.historyLimit)
	}
	e.redoStack = nil
	e.seen[tx["id"].(string)] = true
	e.lastApply = &applied{id: tx["id"].(string), fingerprint: fingerprint, document: e.snapshot, revision: revision}
	return Result{OK: true, Document: e.snapshot, Revision: revision}, nil
}

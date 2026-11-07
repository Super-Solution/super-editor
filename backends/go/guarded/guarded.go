// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

// Package guarded applies guarded transactions to Super Editor documents.
//
// It mirrors packages/core/src/editor.ts for a deliberate subset: flat documents (every block has a
// null parentId) and the operations insertBlock, updateBlock, moveBlock, deleteBlock and setTitle.
// It reproduces exactly: base-revision and per-block version guards, atomic all-or-nothing
// application, block version and revision counters, retired block IDs that can never be reused, and
// idempotent retry of the last successful transaction. conformance/guarded-apply.v1.json is the
// shared test data.
//
// Not covered: content and document schema validation (content is opaque here), nesting, the other
// nine operation types, undo/redo, rebase-safe conflicts and the clock-callback API.
package guarded

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Block is one block of a flat document. Content is opaque JSON in this subset.
type Block struct {
	ID          string   `json:"id"`
	ParentID    *string  `json:"parentId"`
	Content     any      `json:"content"`
	CitationIDs []string `json:"citationIds"`
	Version     int64    `json:"version"`
	CreatedAt   string   `json:"createdAt"`
	UpdatedAt   string   `json:"updatedAt"`
}

// Document is a research document snapshot.
type Document struct {
	SchemaVersion   int      `json:"schemaVersion"`
	ID              string   `json:"id"`
	Title           string   `json:"title"`
	Revision        int64    `json:"revision"`
	CreatedAt       string   `json:"createdAt"`
	UpdatedAt       string   `json:"updatedAt"`
	Format          any      `json:"format"`
	Blocks          []Block  `json:"blocks"`
	Citations       []any    `json:"citations"`
	RetiredBlockIDs []string `json:"retiredBlockIds"`
}

// Transaction is an atomic batch of operations proposed against a base revision.
// Operations are generic JSON objects so that optional keys (afterId) keep their presence.
type Transaction struct {
	ID             string           `json:"id"`
	Actor          any              `json:"actor"`
	BaseRevision   int64            `json:"baseRevision"`
	ConflictPolicy *string          `json:"conflictPolicy,omitempty"`
	Operations     []map[string]any `json:"operations"`
}

// Issue is one reason a transaction was refused.
type Issue struct {
	Code    string `json:"code"`
	BlockID string `json:"blockId,omitempty"`
}

// Result is the outcome of Apply.
type Result struct {
	OK              bool
	Duplicate       bool
	Document        *Document
	Issues          []Issue
	CurrentRevision int64
}

type rejected struct{ issue Issue }

func (r *rejected) Error() string { return r.issue.Code }

func reject(code, blockID string) error { return &rejected{Issue{Code: code, BlockID: blockID}} }

// Editor is a session editor over one document. Pass the clock reading to every Apply call.
type Editor struct {
	snapshot *Document
	versions map[string]int64
	reserved map[string]bool
	seen     map[string]bool
	lastID   string
	lastFP   string
	lastDoc  *Document
}

func clone(d *Document) *Document {
	data, _ := json.Marshal(d)
	var out Document
	_ = json.Unmarshal(data, &out)
	normalise(&out)
	return &out
}

func normalise(d *Document) {
	if d.Blocks == nil {
		d.Blocks = []Block{}
	}
	if d.Citations == nil {
		d.Citations = []any{}
	}
	if d.RetiredBlockIDs == nil {
		d.RetiredBlockIDs = []string{}
	}
	for i := range d.Blocks {
		if d.Blocks[i].CitationIDs == nil {
			d.Blocks[i].CitationIDs = []string{}
		}
	}
}

// New copies the document into a new editor.
func New(document Document) *Editor {
	e := &Editor{snapshot: clone(&document), versions: map[string]int64{}, reserved: map[string]bool{}, seen: map[string]bool{}}
	for _, b := range e.snapshot.Blocks {
		e.versions[b.ID] = b.Version
		e.reserved[b.ID] = true
	}
	for _, id := range e.snapshot.RetiredBlockIDs {
		e.reserved[id] = true
	}
	return e
}

// Snapshot returns a copy of the current document.
func (e *Editor) Snapshot() Document { return *clone(e.snapshot) }

func (e *Editor) failure(err error) Result {
	var r *rejected
	if !errors.As(err, &r) {
		panic(err)
	}
	return Result{Issues: []Issue{r.issue}, CurrentRevision: e.snapshot.Revision}
}

// Apply validates and commits a transaction atomically, or refuses it and changes nothing.
func (e *Editor) Apply(tx Transaction, now string) Result {
	data, _ := json.Marshal(tx)
	var generic any
	_ = json.Unmarshal(data, &generic)
	canonical, _ := json.Marshal(generic) // map keys are sorted, so equal transactions compare equal
	fingerprint := string(canonical)
	if e.seen[tx.ID] {
		if e.lastID == tx.ID && e.lastFP == fingerprint {
			return Result{OK: true, Duplicate: true, Document: clone(e.lastDoc)}
		}
		return e.failure(reject("duplicate", ""))
	}
	if tx.ConflictPolicy != nil {
		panic("conflictPolicy is not part of the proof of concept")
	}
	if tx.BaseRevision != e.snapshot.Revision {
		return e.failure(reject("conflict", ""))
	}
	if now < e.snapshot.UpdatedAt { // ISO UTC strings of one shape sort chronologically
		return e.failure(reject("validation", ""))
	}
	next := clone(e.snapshot)
	highWater := map[string]int64{}
	for k, v := range e.versions {
		highWater[k] = v
	}
	pending := map[string]bool{}
	for k := range e.reserved {
		pending[k] = true
	}
	for _, op := range tx.Operations {
		if err := operate(next, op, highWater, now, pending); err != nil {
			return e.failure(err)
		}
	}
	next.Revision++
	next.UpdatedAt = now
	e.snapshot = next
	e.versions = highWater
	for _, b := range next.Blocks {
		e.reserved[b.ID] = true
	}
	for _, id := range next.RetiredBlockIDs {
		e.reserved[id] = true
	}
	e.seen[tx.ID] = true
	e.lastID, e.lastFP, e.lastDoc = tx.ID, fingerprint, clone(next)
	return Result{OK: true, Document: clone(next)}
}

func tick(b *Block, highWater map[string]int64, at string) {
	if highWater[b.ID] > b.Version {
		b.Version = highWater[b.ID]
	}
	b.Version++
	b.UpdatedAt = at
	highWater[b.ID] = b.Version
}

func indexOf(d *Document, id string) int {
	for i, b := range d.Blocks {
		if b.ID == id {
			return i
		}
	}
	return -1
}

func blockAt(d *Document, id string, expected int64) (int, error) {
	i := indexOf(d, id)
	if i == -1 {
		return 0, reject("not-found", id)
	}
	if d.Blocks[i].Version != expected {
		return 0, reject("conflict", id)
	}
	return i, nil
}

func str(op map[string]any, key string) string {
	s, _ := op[key].(string)
	return s
}

func num(op map[string]any, key string) int64 {
	switch v := op[key].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	}
	return 0
}

func put(d *Document, b Block, op map[string]any) error {
	if b.ParentID != nil {
		panic("nested blocks are not part of the proof of concept")
	}
	position := len(d.Blocks) // omission appends
	if after, present := op["afterId"]; present {
		if after == nil {
			position = 0 // null prepends
		} else {
			id, _ := after.(string)
			if id == b.ID {
				return reject("validation", b.ID)
			}
			anchor := indexOf(d, id)
			if anchor == -1 {
				return reject("validation", b.ID)
			}
			position = anchor + 1
		}
	}
	d.Blocks = append(d.Blocks, Block{})
	copy(d.Blocks[position+1:], d.Blocks[position:])
	d.Blocks[position] = b
	return nil
}

func operate(d *Document, op map[string]any, highWater map[string]int64, at string, pending map[string]bool) error {
	switch kind := str(op, "type"); kind {
	case "insertBlock":
		raw, _ := json.Marshal(op["block"])
		var b Block
		_ = json.Unmarshal(raw, &b)
		if pending[b.ID] || indexOf(d, b.ID) != -1 {
			return reject("duplicate", b.ID)
		}
		if b.CitationIDs == nil {
			b.CitationIDs = []string{}
		}
		b.Version, b.CreatedAt, b.UpdatedAt = 1, at, at
		if err := put(d, b, op); err != nil {
			return err
		}
		highWater[b.ID] = 1
		pending[b.ID] = true
	case "updateBlock":
		i, err := blockAt(d, str(op, "blockId"), num(op, "expectedVersion"))
		if err != nil {
			return err
		}
		d.Blocks[i].Content = op["content"]
		if ids, present := op["citationIds"]; present {
			raw, _ := json.Marshal(ids)
			var list []string
			_ = json.Unmarshal(raw, &list)
			if list == nil {
				list = []string{}
			}
			d.Blocks[i].CitationIDs = list
		}
		tick(&d.Blocks[i], highWater, at)
	case "moveBlock":
		i, err := blockAt(d, str(op, "blockId"), num(op, "expectedVersion"))
		if err != nil {
			return err
		}
		if op["parentId"] != nil {
			panic("nested blocks are not part of the proof of concept")
		}
		b := d.Blocks[i]
		d.Blocks = append(d.Blocks[:i], d.Blocks[i+1:]...)
		if err := put(d, b, op); err != nil {
			return err
		}
		j := indexOf(d, b.ID)
		tick(&d.Blocks[j], highWater, at)
	case "deleteBlock":
		i, err := blockAt(d, str(op, "blockId"), num(op, "expectedVersion"))
		if err != nil {
			return err
		}
		tick(&d.Blocks[i], highWater, at)
		id := d.Blocks[i].ID
		retired := false
		for _, r := range d.RetiredBlockIDs {
			retired = retired || r == id
		}
		if !retired {
			d.RetiredBlockIDs = append(d.RetiredBlockIDs, id)
		}
		d.Blocks = append(d.Blocks[:i], d.Blocks[i+1:]...)
	case "setTitle":
		d.Title = str(op, "title")
	default:
		panic(fmt.Sprintf("operation %s is not part of the proof of concept", kind))
	}
	return nil
}

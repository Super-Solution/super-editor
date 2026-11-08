// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package editor

import (
	"encoding/json"

	"github.com/Super-Solution/super-editor/backends/go/validation"
)

// Undo restores the document before the last applied transaction as a new revision.
func (e *Editor) Undo(actor, expectedRevision any) Result {
	return e.history("undo", actor, expectedRevision)
}

// Redo re-applies the last undone transaction as a new revision.
func (e *Editor) Redo(actor, expectedRevision any) Result {
	return e.history("redo", actor, expectedRevision)
}

func predecessors(d record) map[string]string {
	out := map[string]string{}
	previous := map[any]string{}
	for _, b := range d["blocks"].([]any) {
		block := b.(record)
		id := block["id"].(string)
		out[id] = previous[block["parentId"]]
		previous[block["parentId"]] = id
	}
	return out
}

func fingerprint(b record) string {
	raw, _ := json.Marshal(record{"parentId": b["parentId"], "content": b["content"], "citationIds": b["citationIds"]})
	return string(raw)
}

func (e *Editor) history(kind string, actorValue, expectedValue any) Result {
	e.mu.Lock()
	defer e.mu.Unlock()
	req := validation.ValidateHistoryRequest(actorValue, expectedValue)
	if !req.OK {
		return e.failure(fromValidation(req.Issues))
	}
	request := req.Value.(record)
	if numOf(request, "expectedRevision") != numOf(e.snapshot, "revision") {
		return e.failure([]Issue{{Code: "conflict", Message: "Document changed; re-read before using history."}})
	}
	stack := e.undoStack
	if kind == "redo" {
		stack = e.redoStack
	}
	if len(stack) == 0 {
		return e.failure([]Issue{{Code: "history", Message: "No " + kind + " history is available."}})
	}
	entry := stack[len(stack)-1]
	out, issues := guard("History could not be restored safely.", func() (Result, []Issue) {
		at := e.clock()
		source := entry.before
		if kind == "redo" {
			source = entry.after
		}
		target := cloneRecord(source)
		highWater := make(map[string]float64, len(e.versions))
		for k, v := range e.versions {
			highWater[k] = v
		}
		currentByID := map[string]record{}
		for _, b := range e.snapshot["blocks"].([]any) {
			currentByID[b.(record)["id"].(string)] = b.(record)
		}
		targetIDs := map[string]bool{}
		for _, b := range target["blocks"].([]any) {
			targetIDs[b.(record)["id"].(string)] = true
		}
		// An ordered set: current retired IDs, then the target's, then the blocks this step removes.
		var retired []string
		seen := map[string]bool{}
		add := func(id string) {
			if !seen[id] {
				seen[id] = true
				retired = append(retired, id)
			}
		}
		for _, id := range stringsOf(e.snapshot["retiredBlockIds"]) {
			add(id)
		}
		for _, id := range stringsOf(target["retiredBlockIds"]) {
			add(id)
		}
		currentPred, targetPred := predecessors(e.snapshot), predecessors(target)
		for _, b := range e.snapshot["blocks"].([]any) {
			current := b.(record)
			id := current["id"].(string)
			if !targetIDs[id] {
				base, ok := highWater[id]
				if !ok {
					base = numOf(current, "version")
				}
				highWater[id] = increment(base, "Block "+id)
				add(id)
			}
		}
		// History never copies old versions back: all restored blocks receive their current high-water version.
		for _, b := range target["blocks"].([]any) {
			block := b.(record)
			id := block["id"].(string)
			current, exists := currentByID[id]
			if !exists || fingerprint(current) != fingerprint(block) || currentPred[id] != targetPred[id] {
				tick(block, highWater, at)
			} else {
				block["version"] = current["version"]
				block["updatedAt"] = current["updatedAt"]
			}
		}
		target["retiredBlockIds"] = anyStrings(retired)
		target["revision"] = increment(numOf(e.snapshot, "revision"), "Document")
		target["updatedAt"] = at
		final := validation.ValidateDocument(target)
		if !final.OK {
			return Result{}, fromValidation(final.Issues)
		}
		number := target["revision"].(float64)
		revision := record{"number": number, "transactionId": "history:" + kind + ":" + num(number), "actor": clone(request["actor"]), "at": at, "kind": kind, "operations": []any{}}
		e.commit(final.Value.(record), revision, highWater)
		if kind == "undo" {
			e.undoStack = e.undoStack[:len(e.undoStack)-1]
			e.redoStack = lastN(append(e.redoStack, entry), e.historyLimit)
		} else {
			e.redoStack = e.redoStack[:len(e.redoStack)-1]
			e.undoStack = lastN(append(e.undoStack, entry), e.historyLimit)
		}
		e.lastApply = nil
		return Result{OK: true, Document: e.snapshot, Revision: revision}, nil
	})
	if issues != nil {
		return e.failure(issues)
	}
	return out
}

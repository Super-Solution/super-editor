// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package server

import "github.com/Super-Solution/super-editor/backends/go/editor"

// Service is the session-scoped facade the actions and the HTTP handler work on. Persistence and access control belong
// to the host.
type Service interface {
	// Read returns the current document. Callers must not modify it.
	Read() map[string]any
	Apply(transaction any) editor.Result
	Undo(actor, expectedRevision any) editor.Result
	Redo(actor, expectedRevision any) editor.Result
	// Revisions lists the revisions of the session, oldest first.
	Revisions() []map[string]any
}

type editorService struct{ e *editor.Editor }

// NewService wraps an editor as a Service.
func NewService(e *editor.Editor) Service { return editorService{e} }

func (s editorService) Read() map[string]any                   { return s.e.Snapshot() }
func (s editorService) Apply(tx any) editor.Result             { return s.e.Apply(tx) }
func (s editorService) Undo(actor, expected any) editor.Result { return s.e.Undo(actor, expected) }
func (s editorService) Redo(actor, expected any) editor.Result { return s.e.Redo(actor, expected) }
func (s editorService) Revisions() []map[string]any            { return s.e.Revisions() }

func revisionOf(s Service) float64 {
	n, _ := s.Read()["revision"].(float64)
	return n
}

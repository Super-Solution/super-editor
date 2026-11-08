// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

// Command super-editor-server serves one research document over HTTP, with the same contract as the TypeScript
// handler (GET /openapi.json lists every route). The handler does not authenticate; run it on a private network or
// behind your own gateway.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/Super-Solution/super-editor/backends/go/editor"
	"github.com/Super-Solution/super-editor/backends/go/server"
	"github.com/Super-Solution/super-editor/backends/go/validation"
)

// saving persists the document after every accepted edit, writing a temporary file and renaming it over the target.
// Edits and their saves are serialized, so two requests cannot interleave on the temporary file and the file always
// holds the document of the last accepted edit.
type saving struct {
	server.Service
	path string
	mu   *sync.Mutex
}

func (s saving) edit(step func() editor.Result) editor.Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := step()
	if r.OK && !r.Duplicate {
		if err := writeAtomic(s.path, s.Service.Read()); err != nil {
			log.Printf("saving %s: %v", s.path, err)
		}
	}
	return r
}

func (s saving) Apply(tx any) editor.Result {
	return s.edit(func() editor.Result { return s.Service.Apply(tx) })
}

func (s saving) Undo(actor, expected any) editor.Result {
	return s.edit(func() editor.Result { return s.Service.Undo(actor, expected) })
}

func (s saving) Redo(actor, expected any) editor.Result {
	return s.edit(func() editor.Result { return s.Service.Redo(actor, expected) })
}

func writeAtomic(path string, document map[string]any) error {
	raw, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func main() {
	file := flag.String("document", "", "path of the document JSON file (required)")
	addr := flag.String("addr", "127.0.0.1:8787", "listen address")
	readOnly := flag.Bool("read-only", false, "refuse every route that can change the document")
	save := flag.Bool("save", false, "write the document back to the file after every accepted edit")
	basePath := flag.String("base-path", "", "path prefix the server is mounted under, for example /api/reports/42")
	cors := flag.String("cors", "", `allowed origins, comma separated, or "*" (off by default)`)
	maxBody := flag.Int64("max-body-bytes", 0, "largest accepted request body (default 1 MiB)")
	flag.Parse()
	if *file == "" {
		flag.Usage()
		os.Exit(2)
	}
	raw, err := os.ReadFile(*file)
	if err != nil {
		log.Fatal(err)
	}
	document, err := validation.Decode(raw)
	if err != nil {
		log.Fatalf("%s: %v", *file, err)
	}
	ed, err := editor.New(document, editor.Options{Now: func() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }})
	if err != nil {
		log.Fatalf("%s: %v", *file, err)
	}
	var service server.Service = server.NewService(ed)
	if *save && !*readOnly {
		service = saving{service, *file, &sync.Mutex{}}
	}
	opts := server.Options{ReadOnly: *readOnly, BasePath: *basePath, MaxBodyBytes: *maxBody}
	if *cors == "*" {
		opts.CORS = &server.CORS{AllowAny: true}
	} else if *cors != "" {
		opts.CORS = &server.CORS{Origins: strings.Split(*cors, ",")}
	}
	handler, err := server.NewHandler(service, opts)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Fprintf(os.Stderr, "super-editor-server: %s on http://%s\n", *file, *addr)
	srv := &http.Server{
		Addr: *addr, Handler: handler,
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 120 * time.Second,
		MaxHeaderBytes: 64 << 10,
	}
	log.Fatal(srv.ListenAndServe())
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestWriteAtomicKeepsPermissionsAndSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits and symlinks")
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "real.json")
	link := filepath.Join(dir, "link.json")
	if err := os.WriteFile(target, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(target, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := writeAtomic(link, map[string]any{"title": "saved"}); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the link must stay a link: %v %v", info, err)
	}
	if info, err := os.Stat(target); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("a private document must stay private: %v %v", info, err)
	}
	raw, err := os.ReadFile(target)
	if err != nil || string(raw) != "{\n  \"title\": \"saved\"\n}\n" {
		t.Fatalf("the real document holds the edit: %q %v", raw, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 2 {
		t.Fatalf("no temporary file may remain: %v %v", entries, err)
	}
}

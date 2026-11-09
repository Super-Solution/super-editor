# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""``-save`` keeps the permissions of the document and writes through a symlink."""

from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

from super_editor.server.__main__ import _dump_document, _read_document_text, _write_atomic


@unittest.skipIf(sys.platform == "win32", "POSIX permission bits and symlinks")
class WriteAtomicTest(unittest.TestCase):
    def test_keeps_permissions_and_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target, link = root / "real.json", root / "link.json"
            target.write_text("{}\n", encoding="utf-8")
            target.chmod(0o600)
            link.symlink_to(target)
            _write_atomic(str(link), {"title": "saved \u2713"})
            self.assertTrue(link.is_symlink(), "the link stays a link")
            self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), 0o600)
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"title": "saved \u2713"})
            self.assertEqual(sorted(entry.name for entry in root.iterdir()), ["link.json", "real.json"])


class LoneSurrogateTest(unittest.TestCase):
    def test_saves_a_lone_surrogate_as_an_escape(self) -> None:
        document = {"title": "a\ud800b \u2713 \U0001f600"}
        self.assertEqual(_dump_document(document), '{\n  "title": "a\\ud800b \u2713 \U0001f600"\n}')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "doc.json"
            _write_atomic(str(path), document)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), document)


class ReadDocumentTextTest(unittest.TestCase):
    def test_enforces_the_limit_while_reading(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            small = Path(directory) / "small.json"
            small.write_text("{}", encoding="utf-8")
            self.assertEqual(_read_document_text(str(small)), "{}")
        if sys.platform != "win32":
            with self.assertRaises(SystemExit) as raised:
                _read_document_text("/dev/zero")
            self.assertIn("larger than", str(raised.exception))


if __name__ == "__main__":
    unittest.main()

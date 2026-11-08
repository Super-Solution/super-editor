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

from super_editor.server.__main__ import _write_atomic


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


if __name__ == "__main__":
    unittest.main()

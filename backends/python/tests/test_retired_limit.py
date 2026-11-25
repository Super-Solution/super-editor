# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""The cap on reserved (deleted) block IDs: refused one over, accepted at the limit.

The recovery hint is the same as the reference's.
"""

import unittest
from pathlib import Path
from typing import Any

from super_editor.validation import RETIRED_LIMIT, RETIRED_LIMIT_HINT, validate_document

AT = "2026-10-03T12:00:00.000Z"


def document(count: int) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "id": "d",
        "title": "T",
        "revision": 0,
        "createdAt": AT,
        "updatedAt": AT,
        "format": {"page": "screen", "font": "sans", "fontSize": 16, "lineHeight": 1.6},
        "blocks": [],
        "citations": [],
        "retiredBlockIds": [f"r{index}" for index in range(count)],
    }


class RetiredLimit(unittest.TestCase):
    def test_at_the_limit_is_valid(self) -> None:
        self.assertTrue(validate_document(document(RETIRED_LIMIT))["ok"])

    def test_one_over_says_how_to_recover(self) -> None:
        result = validate_document(document(RETIRED_LIMIT + 1))
        self.assertFalse(result["ok"])
        self.assertEqual(
            result["issues"],
            [
                {
                    "code": "validation",
                    "message": "Expected an array with at most 100000 entries.",
                    "path": "document.retiredBlockIds",
                    "hint": RETIRED_LIMIT_HINT,
                }
            ],
        )

    def test_hint_matches_the_typescript_reference(self) -> None:
        source = Path(__file__).resolve().parents[3] / "packages" / "core" / "src" / "validation.ts"
        if not source.exists():
            self.skipTest("TypeScript source not next to the backend")
        self.assertIn(f"RETIRED_LIMIT_HINT = '{RETIRED_LIMIT_HINT}'", source.read_text())


if __name__ == "__main__":
    unittest.main()

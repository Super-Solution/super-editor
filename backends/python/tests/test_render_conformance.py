# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""Replays conformance/render.v1.json (generated from the TypeScript reference) through the Python read side."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from super_editor.export import to_markdown
from super_editor.html_export import to_html
from super_editor.inline import inline_to_plain, parse_inline, runs_to_markdown
from super_editor.markdown_import import from_markdown
from super_editor.query import find_blocks, get_outline
from super_editor.text import count_words, document_stats, to_plain_text

DATA: dict[str, Any] = json.loads((Path(__file__).parents[3] / "conformance" / "render.v1.json").read_text("utf-8"))


def test_inline() -> None:
    for case in DATA["inline"]:
        runs = parse_inline(case["input"])
        assert runs == case["runs"], case["input"]
        assert runs_to_markdown(runs) == case["markdown"], case["input"]
        assert inline_to_plain(case["input"]) == case["plain"], case["input"]


def test_runs_to_markdown() -> None:
    for case in DATA["runsToMarkdown"]:
        assert runs_to_markdown(case["runs"]) == case["markdown"], case["runs"]


def test_from_markdown() -> None:
    for case in DATA["fromMarkdown"]:
        o = case["options"]
        blocks = from_markdown(
            case["markdown"],
            id_prefix=o["idPrefix"],
            parent_id=o.get("parentId"),
            citation_markers=o.get("citationMarkers", True),
        )
        assert blocks == case["blocks"], case["markdown"]


def test_bad_prefixes() -> None:
    for case in DATA["badPrefixes"]:
        with pytest.raises(ValueError):
            from_markdown("x", id_prefix=case["idPrefix"])


def test_documents() -> None:
    for i, case in enumerate(DATA["documents"]):
        doc = case["document"]
        assert to_markdown(doc) == case["markdown"], i
        assert to_markdown(doc, title=False, chart_rows_limit=2) == case["markdownBare"], i
        assert to_html(doc) == case["html"], i
        assert to_html(doc, title=False, chart_rows_limit=2) == case["htmlBare"], i
        assert to_html(doc, standalone=True) == case["htmlStandalone"], i
        assert to_plain_text(doc) == case["text"], i
        assert to_plain_text(doc, title=False, chart_rows_limit=1) == case["textBare"], i
        assert document_stats(doc) == case["stats"], i
        assert get_outline(doc) == case["outline"], i
        for q in case["queries"]:
            assert [b["id"] for b in find_blocks(doc, q["selector"])] == q["ids"], (i, q["selector"])


def test_words() -> None:
    for case in DATA["words"]:
        assert count_words(case["text"]) == (case["latin"], case["cjk"]), case["text"]

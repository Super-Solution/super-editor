# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""Reading-order traversal, block search and the document outline (port of packages/core/src/query.ts).

Documents are decoded JSON (dicts and lists). A selector uses the same keys as the TypeScript ``BlockSelector``:
``type`` (a string or a list), ``text``, ``caseSensitive``, ``parentId`` (``None`` selects the top level), ``ids``,
``citationId``, ``within`` and ``limit``. All selectors combine with AND.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .documents import content_text

Block = dict[str, Any]
Document = Mapping[str, Any]


def blocks_of(doc: Document) -> list[Block]:
    return list(doc.get("blocks") or [])


def child_index(blocks: list[Block]) -> dict[str | None, list[Block]]:
    index: dict[str | None, list[Block]] = {}
    for block in blocks:
        index.setdefault(block.get("parentId"), []).append(block)
    return index


def ordered_blocks(doc: Document) -> list[Block]:
    """All blocks in reading order: a pre-order walk of the tree, siblings in stored order."""
    blocks = blocks_of(doc)
    index = child_index(blocks)
    seen: set[str] = set()
    out: list[Block] = []

    def walk(parent: str | None) -> None:
        for block in index.get(parent, []):
            if block["id"] in seen:
                continue
            seen.add(block["id"])
            out.append(block)
            walk(block["id"])

    walk(None)
    # A valid document has no unreachable blocks; keep any that exist rather than dropping data.
    out.extend(block for block in blocks if block["id"] not in seen)
    return out


def descendants_of(doc: Document, block_id: str) -> list[Block]:
    """Every block below ``block_id``, in reading order."""
    index = child_index(blocks_of(doc))
    seen = {block_id}
    out: list[Block] = []

    def walk(parent: str) -> None:
        for block in index.get(parent, []):
            if block["id"] in seen:
                continue
            seen.add(block["id"])
            out.append(block)
            walk(block["id"])

    walk(block_id)
    return out


def block_text(block: Block) -> str:
    """The searchable text of a block: every text field joined by newlines."""
    return content_text(block["content"])


def _cites(block: Block, citation_id: str) -> bool:
    if citation_id in (block.get("citationIds") or []):
        return True
    return any(run.get("citationId") == citation_id for run in block["content"].get("runs") or [])


def find_blocks(doc: Document, selector: Mapping[str, Any] | None = None) -> list[Block]:
    """The matching blocks in reading order. An empty selector returns every block."""
    s = selector or {}
    kinds = s.get("type")
    types = None if kinds is None else {kinds} if isinstance(kinds, str) else set(kinds)
    ids = None if s.get("ids") is None else set(s["ids"])
    within = None if s.get("within") is None else {b["id"] for b in descendants_of(doc, s["within"])}
    case_sensitive = bool(s.get("caseSensitive"))
    needle = s.get("text")
    if needle is not None and not case_sensitive:
        needle = needle.lower()
    limit = s.get("limit")
    out: list[Block] = []
    for block in ordered_blocks(doc):
        if limit is not None and len(out) >= limit:
            break
        if types is not None and block["content"]["type"] not in types:
            continue
        if ids is not None and block["id"] not in ids:
            continue
        if "parentId" in s and block.get("parentId") != s["parentId"]:
            continue
        if within is not None and block["id"] not in within:
            continue
        if s.get("citationId") is not None and not _cites(block, s["citationId"]):
            continue
        if needle is not None:
            text = block_text(block)
            if not case_sensitive:
                text = text.lower()
            if needle not in text:
                continue
        out.append(block)
    return out


def get_outline(doc: Document) -> list[dict[str, Any]]:
    """The document's skeleton. Sections nest by containment and headings nest by level inside their container; a
    section closes the headings before it, and toggles are transparent."""
    index = child_index(blocks_of(doc))
    seen: set[str] = set()

    def nest(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        root: list[dict[str, Any]] = []
        stack: list[dict[str, Any]] = []
        for item in items:
            if item["type"] == "section":
                stack = []
                root.append(item)
                continue
            while stack and stack[-1]["level"] >= item["level"]:
                stack.pop()
            (stack[-1]["children"] if stack else root).append(item)
            stack.append(item)
        return root

    def entries(parent: str | None, depth: int) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for block in index.get(parent, []):
            if block["id"] in seen:
                continue
            seen.add(block["id"])
            content = block["content"]
            kind = content["type"]
            if kind == "section":
                children = nest(entries(block["id"], depth + 1))
                out.append(
                    {
                        "id": block["id"],
                        "type": "section",
                        "title": content["title"],
                        "level": depth,
                        "children": children,
                    }
                )
            elif kind == "heading":
                out.append(
                    {
                        "id": block["id"],
                        "type": "heading",
                        "title": content["text"],
                        "level": content["level"],
                        "children": [],
                    }
                )
            elif kind == "toggle":
                out.extend(entries(block["id"], depth))
        return out

    return nest(entries(None, 1))

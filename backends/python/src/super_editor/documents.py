# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""Pure document functions: block text extraction, structural diff and revision summaries.

Ported from packages/core/src/text.ts and diff.ts in the TypeScript reference; conformance/
document-ops.v1.json pins every behaviour. Documents are decoded JSON (dicts and lists).

Limits: titles in summaries are sliced by UTF-16 code units in the reference, so the data uses BMP
characters only; the reference compares blocks through JSON.stringify, so objects must keep a stable
key order for the two sides to count as equal there (here they compare as values).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any, TypedDict

Json = Any


def _runs_text(runs: Iterable[Mapping[str, Any]]) -> str:
    return "".join(run["text"] for run in runs)


def _opt(content: Mapping[str, Any], key: str) -> list[str]:
    return [content[key]] if key in content else []


def text_parts(content: Mapping[str, Any]) -> list[str]:
    """The human-visible, replaceable text of a block, one string per text field in document order."""
    kind = content["type"]
    if kind in ("section", "toggle"):
        return [content["title"]]
    if kind in ("heading", "code"):
        return [content["text"]]
    if kind == "paragraph":
        return [_runs_text(content["runs"])]
    if kind == "quote":
        return [_runs_text(content["runs"]), *_opt(content, "attribution")]
    if kind == "callout":
        return [*_opt(content, "title"), _runs_text(content["runs"])]
    if kind == "list":
        return list(content["items"])
    if kind == "table":
        return [*_opt(content, "caption"), "\t".join(content["columns"]), *("\t".join(row) for row in content["rows"])]
    if kind == "chart":
        spec = content["spec"]
        return [spec["title"], *_opt(spec, "caption")]
    if kind == "embed":
        return [content["title"]]
    if kind == "image":
        return [content["alt"], *_opt(content, "caption")]
    if kind == "metrics":
        return [part for item in content["items"] for part in (item["label"], item["value"], *_opt(item, "hint"))]
    if kind == "timestamp":
        return [content["label"]]
    return []  # divider, toc, pageBreak


def content_text(content: Mapping[str, Any]) -> str:
    return "\n".join(text_parts(content))


class CitationDiff(TypedDict):
    added: list[str]
    removed: list[str]
    changed: list[str]


class DocumentDiff(TypedDict):
    added: list[str]
    removed: list[str]
    changed: list[str]
    moved: list[str]
    titleChanged: bool
    formatChanged: bool
    citations: CitationDiff


def _same(a: Any, b: Any) -> bool:
    """JSON equality: like ==, but true is not 1 and 1.0 is 1, as in JSON.stringify comparisons."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b, strict=True))
    return bool(a == b)


def _stable(values: Sequence[int]) -> set[int]:
    """Positions of a longest increasing subsequence of `values`; only blocks outside it count as moved."""
    tails: list[int] = []
    previous = [-1] * len(values)
    for index, value in enumerate(values):
        low, high = 0, len(tails)
        while low < high:
            middle = (low + high) >> 1
            if values[tails[middle]] < value:
                low = middle + 1
            else:
                high = middle
        if low > 0:
            previous[index] = tails[low - 1]
        if low == len(tails):
            tails.append(index)
        else:
            tails[low] = index
    keep: set[int] = set()
    cursor = tails[-1] if tails else -1
    while cursor >= 0:
        keep.add(cursor)
        cursor = previous[cursor]
    return keep


def diff_documents(a: Mapping[str, Any], b: Mapping[str, Any]) -> DocumentDiff:
    """Structural comparison by block ID. Versions and timestamps are ignored."""
    before = {block["id"]: block for block in a["blocks"]}
    after = {block["id"]: block for block in b["blocks"]}
    added = [block["id"] for block in b["blocks"] if block["id"] not in before]
    removed = [block["id"] for block in a["blocks"] if block["id"] not in after]
    changed: list[str] = []
    moved: set[str] = set()
    for block in b["blocks"]:
        old = before.get(block["id"])
        if old is None:
            continue
        if not _same([old["content"], old["citationIds"]], [block["content"], block["citationIds"]]):
            changed.append(block["id"])
        if old["parentId"] != block["parentId"]:
            moved.add(block["id"])
    for parent_id in {block["parentId"] for block in b["blocks"]}:
        order = {block["id"]: i for i, block in enumerate(x for x in a["blocks"] if x["parentId"] == parent_id)}
        common = [block for block in b["blocks"] if block["parentId"] == parent_id and block["id"] in order]
        keep = _stable([order[block["id"]] for block in common])
        moved.update(block["id"] for i, block in enumerate(common) if i not in keep)
    old_citations = {c["id"]: c for c in a["citations"]}
    new_citations = {c["id"]: c for c in b["citations"]}
    return {
        "added": added,
        "removed": removed,
        "changed": changed,
        "moved": [block["id"] for block in b["blocks"] if block["id"] in moved],
        "titleChanged": a["title"] != b["title"],
        "formatChanged": not _same(a["format"], b["format"]),
        "citations": {
            "added": [c["id"] for c in b["citations"] if c["id"] not in old_citations],
            "removed": [c["id"] for c in a["citations"] if c["id"] not in new_citations],
            "changed": [
                c["id"] for c in b["citations"] if c["id"] in old_citations and not _same(old_citations[c["id"]], c)
            ],
        },
    }


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}{'' if count == 1 else 's'}"


def _sentence(parts: list[str]) -> str:
    if len(parts) < 2:
        return parts[0] if parts else ""
    return f"{', '.join(parts[:-1])} and {parts[-1]}"


def summarize_revision(revision: Mapping[str, Any]) -> str:
    """One human sentence for a revision, for history lists and toasts."""
    kind = revision["actor"]["kind"]
    who = f"{kind[:1].upper()}{kind[1:]} {revision['actor']['id']}"
    if revision["kind"] == "undo":
        return f"{who} undid the previous change."
    if revision["kind"] == "redo":
        return f"{who} redid a change."
    ops: list[Mapping[str, Any]] = revision["operations"]
    parts: list[str] = []

    def touched(pick: Any) -> int:
        return len({block_id for op in ops for block_id in pick(op)})

    inserted = sum(
        1 if op["type"] == "insertBlock" else len(op["blocks"]) if op["type"] == "insertBlocks" else 0 for op in ops
    )
    duplicated = sum(1 for op in ops if op["type"] == "duplicateBlock")
    edited = touched(lambda op: [op["blockId"]] if op["type"] == "updateBlock" else [])
    replaced = touched(lambda op: [op["blockId"]] if op["type"] == "replaceText" else [])
    moved = touched(
        lambda op: (
            [op["blockId"]]
            if op["type"] == "moveBlock"
            else [b["blockId"] for b in op["blocks"]]
            if op["type"] == "moveBlocks"
            else []
        )
    )
    deleted = touched(
        lambda op: (
            [op["blockId"]]
            if op["type"] == "deleteBlock"
            else [b["blockId"] for b in op["blocks"]]
            if op["type"] == "deleteBlocks"
            else []
        )
    )
    if inserted:
        parts.append(f"inserted {_plural(inserted, 'block')}")
    if duplicated:
        parts.append(f"duplicated {_plural(duplicated, 'block')}")
    if edited:
        parts.append(f"edited {_plural(edited, 'block')}")
    if replaced:
        parts.append(f"replaced text in {_plural(replaced, 'block')}")
    if moved:
        parts.append(f"moved {_plural(moved, 'block')}")
    if deleted:
        parts.append(f"deleted {_plural(deleted, 'block')}")
    title = next((op for op in reversed(ops) if op["type"] == "setTitle"), None)
    if title is not None:
        name = title["title"]
        shown = f"{name[:57]}..." if _utf16_length(name) > 60 else name
        parts.append(f"renamed the document to “{shown}”")
    if any(op["type"] == "setFormat" for op in ops):
        parts.append("changed the page format")
    for label, op_type in (("added", "addCitation"), ("updated", "updateCitation"), ("removed", "removeCitation")):
        count = sum(1 for op in ops if op["type"] == op_type)
        if count:
            parts.append(f"{label} {_plural(count, 'citation')}")
    return f"{who} {_sentence(parts) if parts else 'made no changes'}."


def _utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2

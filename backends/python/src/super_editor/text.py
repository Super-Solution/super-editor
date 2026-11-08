# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""Plain-text export and document statistics (port of packages/core/src/export.ts toPlainText and stats.ts)."""

from __future__ import annotations

import math
import unicodedata
from typing import Any

from ._common import (
    Tree,
    annotation_line,
    block_sources,
    chart_data,
    chart_descriptor,
    chart_rows,
    checked_at,
    indent_at,
    is_ordered,
    items,
    percent,
    rec,
    slice_chars,
    source_line,
    strings,
    table_rows,
    text_of,
)
from ._scripts import HAN, HIRAGANA, KATAKANA
from .documents import text_parts
from .inline import JS_SPACE
from .query import Document, blocks_of, get_outline

_CJK_RANGES = HAN + HIRAGANA + KATAKANA


def _outline_lines(entries: list[dict[str, Any]], depth: int) -> list[str]:
    out: list[str] = []
    for item in entries:
        out.append("  " * depth + item["title"])
        out.extend(_outline_lines(item["children"], depth + 1))
    return out


def to_plain_text(doc: Document, *, title: bool = True, chart_rows_limit: int | None = None) -> str:
    """Readable text without markup: lists keep their markers, tables become tab-separated rows, charts a short data
    listing. ``chart_rows_limit`` caps the rows shown for each chart (default 20)."""
    tree = Tree(doc)
    rows_cap = chart_rows(chart_rows_limit, 20)
    parts: list[str] = []

    def label(cid: str) -> str:
        return str(tree.numbers[cid]) if cid in tree.numbers else cid

    def with_markers(runs: list[dict[str, Any]]) -> str:
        return "".join(r["text"] + (f"[{label(r['citationId'])}]" if "citationId" in r else "") for r in runs)

    def render(block: dict[str, Any]) -> None:  # noqa: C901, PLR0912
        c = block["content"]
        kind = c["type"]
        before = len(parts)
        if kind in ("section", "toggle"):
            parts.append(text_of(c, "title"))
        elif kind in ("heading", "code"):
            parts.append(text_of(c, "text"))
        elif kind == "paragraph":
            parts.append(with_markers(c["runs"]))
        elif kind == "list":
            ordered = is_ordered(c)
            counters: list[int] = []
            lines: list[str] = []
            for i, item in enumerate(strings(c.get("items"))):
                level = indent_at(c, i)
                while len(counters) < level + 1:
                    counters.append(0)
                del counters[level + 1 :]
                counters[level] += 1
                if text_of(c, "style") == "todo":
                    marker = "[" + ("x" if checked_at(c, i) else " ") + "]"
                elif ordered:
                    marker = f"{counters[level]}."
                else:
                    marker = "-"
                lines.append("  " * level + marker + " " + item)
            parts.append("\n".join(lines))
        elif kind == "table":
            lines = []
            if text_of(c, "caption"):
                lines.append(text_of(c, "caption"))
            lines.append("\t".join(strings(c.get("columns"))))
            lines.extend("\t".join(row) for row in table_rows(c))
            parts.append("\n".join(lines))
        elif kind == "chart":
            spec = rec(c.get("spec"))
            data = chart_data(spec, rows_cap)
            lines = [text_of(spec, "title") + " (" + chart_descriptor(spec) + ")", "\t".join(data.head)]
            lines.extend("\t".join(row) for row in data.rows)
            if data.omitted > 0:
                lines.append(f"… {data.omitted} more rows")
            lines.extend(
                extra for extra in (annotation_line(spec), text_of(spec, "caption"), source_line(spec)) if extra
            )
            parts.append("\n".join(lines))
        elif kind == "embed":
            parts.append(text_of(c, "title") + " (" + text_of(c, "url") + ")")
        elif kind == "timestamp":
            parts.append(text_of(c, "label") + ": " + text_of(c, "at"))
        elif kind == "quote":
            s = "“" + with_markers(c["runs"]) + "”"
            if text_of(c, "attribution"):
                s += " — " + text_of(c, "attribution")
            parts.append(s)
        elif kind == "callout":
            tone = text_of(c, "tone")
            s = tone[:1].upper() + tone[1:]
            if text_of(c, "title"):
                s += ": " + text_of(c, "title")
            parts.append(s + "\n" + with_markers(c["runs"]))
        elif kind in ("divider", "pageBreak"):
            parts.append("----")
        elif kind == "image":
            name = text_of(c, "alt") or text_of(c, "url")
            s = "[Image: " + name + "]"
            if text_of(c, "caption"):
                s += " " + text_of(c, "caption")
            parts.append(s)
        elif kind == "metrics":
            lines = []
            for it in items(c.get("items")):
                m = rec(it)
                s = text_of(m, "label") + ": " + text_of(m, "value")
                if "change" in m:
                    s += " (" + percent(m["change"]) + ")"
                if text_of(m, "hint"):
                    s += " — " + text_of(m, "hint")
                lines.append(s)
            parts.append("\n".join(lines))
        elif kind == "toc":
            outline = _outline_lines(get_outline(doc), 0)
            if outline:
                parts.append("\n".join(outline))
        extra = block_sources(block)
        if extra and len(parts) > before:
            parts[-1] += " " + "".join(f"[{label(cid)}]" for cid in extra)
        for child in tree.children.get(block["id"], []):
            render(child)

    if title and text_of(doc, "title"):
        parts.append(doc["title"])
    for block in tree.children.get(None, []):
        render(block)
    citations = items(doc.get("citations"))
    if citations:
        lines = ["Sources"]
        for i, ci in enumerate(citations):
            c = rec(ci)
            lines.append(
                f"[{i + 1}] {text_of(c, 'title')} — {text_of(c, 'url')} "
                f"(accessed {slice_chars(text_of(c, 'accessedAt'), 10)})"
            )
        parts.append("\n".join(lines))
    return "\n\n".join(p for p in parts if p) + "\n"


# ---- statistics -----------------------------------------------------------------------------------------------------


def _is_cjk(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in _CJK_RANGES)


def _is_token_char(ch: str) -> bool:
    return unicodedata.category(ch)[0] in "LNM"


def count_words(text: str) -> tuple[int, int]:
    """Count the words in one string: ``(latin, cjk)`` - Latin-style tokens and CJK characters."""
    chars = list(text)
    cjk = 0
    for i, ch in enumerate(chars):
        if _is_cjk(ch):
            cjk += 1
            chars[i] = " "
    latin = 0
    i = 0
    while i < len(chars):
        if not _is_token_char(chars[i]):
            i += 1
            continue
        while i < len(chars) and _is_token_char(chars[i]):
            i += 1
        while i + 1 < len(chars) and chars[i] in "'’.,-" and _is_token_char(chars[i + 1]):
            i += 1
            while i < len(chars) and _is_token_char(chars[i]):
                i += 1
        latin += 1
    return latin, cjk


def document_stats(doc: Document) -> dict[str, Any]:
    """Words, characters, block counts and reading time."""
    latin = cjk = characters = no_spaces = 0
    by_type: dict[str, int] = {}
    blocks = blocks_of(doc)
    for block in blocks:
        kind = block["content"]["type"]
        by_type[kind] = by_type.get(kind, 0) + 1
        for part in text_parts(block["content"]):
            lat, cj = count_words(part)
            latin += lat
            cjk += cj
            characters += len(part)
            no_spaces += sum(1 for ch in part if ch not in JS_SPACE)
    minutes = latin / 220 + cjk / 400
    return {
        "words": latin + cjk,
        "characters": characters,
        "charactersNoSpaces": no_spaces,
        "blocks": len(blocks),
        "blocksByType": by_type,
        "charts": by_type.get("chart", 0),
        "tables": by_type.get("table", 0),
        "images": by_type.get("image", 0),
        "citations": len(items(doc.get("citations"))),
        "readingMinutes": max(1, math.ceil(minutes)) if minutes > 0 else 0,
    }

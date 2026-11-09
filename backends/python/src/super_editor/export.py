# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""Markdown export (port of packages/core/src/export.ts toMarkdown).

Charts become data tables, callouts GitHub alerts, citations footnotes. Underline, highlight, image and embed sizing
and the open state of toggles are dropped.
"""

from __future__ import annotations

from collections.abc import Sequence
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
    line,
    percent,
    rec,
    slice_chars,
    source_line,
    strings,
    table_rows,
    text_of,
)
from .inline import escape_heading_text, escape_inline, escape_line_starts, js_trim, parens, runs_to_markdown
from .query import Document, get_outline

_ALERTS = {"info": "NOTE", "success": "TIP", "note": "IMPORTANT", "warning": "WARNING", "danger": "CAUTION"}
_RULES = {"left": ":---", "right": "---:", "center": ":---:"}


def _md_table(head: Sequence[str], rows: Sequence[Sequence[str]], align: Sequence[str] | None = None) -> str:
    def cell(text: str) -> str:
        return escape_inline(line(text)).replace("|", "\\|")

    align = align or []
    rule = [_RULES.get(align[i], "---") if i < len(align) else "---" for i in range(len(head))]
    out = ["| " + " | ".join(cell(h) for h in head) + " |", "| " + " | ".join(rule) + " |"]
    out.extend("| " + " | ".join(cell(c) for c in row) + " |" for row in rows)
    return "\n".join(out)


def _fence(text: str, language: str) -> str:
    longest = 2
    run = 0
    for ch in text:
        if ch == "`":
            run += 1
            longest = max(longest, run)
        else:
            run = 0
    marks = "`" * (longest + 1)
    return f"{marks}{language}\n{text}\n{marks}"


def _quoted(text: str) -> str:
    return "\n".join("> " + row if row else ">" for row in text.split("\n"))


def _list_markdown(content: dict[str, Any]) -> str:
    ordered = is_ordered(content)
    pad = "   " if ordered else "  "
    counters: list[int] = []
    out: list[str] = []
    for i, item in enumerate(strings(content.get("items"))):
        level = indent_at(content, i)
        while len(counters) < level + 1:
            counters.append(0)
        del counters[level + 1 :]
        counters[level] += 1
        if text_of(content, "style") == "todo":
            marker = "- [" + ("x" if checked_at(content, i) else " ") + "] "
        elif ordered:
            marker = f"{counters[level]}. "
        else:
            marker = "- "
        out.append(pad * level + marker + escape_line_starts(escape_inline(line(item))))
    return "\n".join(out)


def _outline_markdown(entries: Sequence[dict[str, Any]], depth: int) -> list[str]:
    out: list[str] = []
    for item in entries:
        out.append("  " * depth + "- " + escape_line_starts(escape_inline(line(item["title"]))))
        out.extend(_outline_markdown(item["children"], depth + 1))
    return out


def to_markdown(doc: Document, *, title: bool = True, chart_rows_limit: int | None = None) -> str:
    """Render a document as Markdown for reading and exchange. ``title=False`` leaves out the document title;
    ``chart_rows_limit`` caps the rows shown for each chart (default 100)."""
    tree = Tree(doc)
    rows_cap = chart_rows(chart_rows_limit, 100)
    parts: list[str] = []
    if title and text_of(doc, "title"):
        parts.append("# " + escape_heading_text(line(doc["title"])))

    def render(block: dict[str, Any], depth: int) -> None:
        c = block["content"]
        kind = c["type"]
        if kind == "section":
            parts.append("#" * min(6, 2 + depth) + " " + escape_heading_text(line(text_of(c, "title"))))
        elif kind == "toggle":
            parts.append("**" + escape_inline(line(text_of(c, "title"))) + "**")
        elif kind == "heading":
            parts.append("#" * min(6, int(c["level"]) + depth) + " " + escape_heading_text(line(text_of(c, "text"))))
        elif kind == "paragraph":
            text = escape_line_starts(runs_to_markdown(c["runs"]))
            if js_trim(text) != "":
                parts.append(text)
        elif kind == "list":
            parts.append(_list_markdown(c))
        elif kind == "table":
            parts.append(_md_table(strings(c.get("columns")), table_rows(c), strings(c.get("align"))))
            if caption := text_of(c, "caption"):
                parts.append("*" + escape_inline(line(caption)) + "*")
        elif kind == "chart":
            spec = rec(c.get("spec"))
            data = chart_data(spec, rows_cap)
            parts.append("**" + escape_inline(line(text_of(spec, "title"))) + "** (" + chart_descriptor(spec) + ")")
            parts.append(_md_table(data.head, data.rows))
            if data.omitted > 0:
                parts.append(f"*… {data.omitted} more rows omitted*")
            for extra in (annotation_line(spec), text_of(spec, "caption"), source_line(spec)):
                if extra:
                    parts.append(escape_line_starts(escape_inline(line(extra))))
        elif kind == "embed":
            parts.append("[" + escape_inline(line(text_of(c, "title"))) + "](" + parens(text_of(c, "url")) + ")")
        elif kind == "timestamp":
            parts.append(escape_line_starts(escape_inline(line(text_of(c, "label"))) + ": " + text_of(c, "at")))
        elif kind == "quote":
            body = escape_line_starts(runs_to_markdown(c["runs"]))
            if attribution := text_of(c, "attribution"):
                body += "\n\n— " + escape_inline(line(attribution))
            parts.append(_quoted(body))
        elif kind == "callout":
            body = escape_line_starts(runs_to_markdown(c["runs"]))
            title = "**" + escape_inline(line(text_of(c, "title"))) + "**\n" if text_of(c, "title") else ""
            parts.append(_quoted("[!" + _ALERTS.get(text_of(c, "tone"), "") + "]\n" + title + body))
        elif kind == "code":
            parts.append(_fence(text_of(c, "text"), text_of(c, "language")))
        elif kind == "divider":
            parts.append("---")
        elif kind == "pageBreak":
            parts.append("***")
        elif kind == "image":
            parts.append("![" + escape_inline(line(text_of(c, "alt"))) + "](" + parens(text_of(c, "url")) + ")")
            if caption := text_of(c, "caption"):
                parts.append("*" + escape_inline(line(caption)) + "*")
        elif kind == "metrics":
            metrics = [rec(m) for m in items(c.get("items"))]
            change = any("change" in m for m in metrics)
            hint = any(text_of(m, "hint") for m in metrics)
            head = ["Metric", "Value", *(["Change"] if change else []), *(["Note"] if hint else [])]
            body_rows = []
            for m in metrics:
                row = [text_of(m, "label"), text_of(m, "value")]
                if change:
                    row.append(percent(m["change"]) if "change" in m else "")
                if hint:
                    row.append(text_of(m, "hint"))
                body_rows.append(row)
            parts.append(_md_table(head, body_rows))
        elif kind == "toc":
            outline = _outline_markdown(get_outline(doc), 0)
            if outline:
                parts.append("\n".join(outline))
        sources = block_sources(block)
        if sources:
            parts.append("Sources: " + " ".join(f"[^{s}]" for s in sources))
        nxt = depth + 1 if kind == "section" else depth
        for child in tree.children.get(block["id"], []):
            render(child, nxt)

    for block in tree.children.get(None, []):
        render(block, 0)
    citations = items(doc.get("citations"))
    if citations:
        lines = []
        for ci in citations:
            c = rec(ci)
            s = (
                f"[^{text_of(c, 'id')}]: [{escape_inline(line(text_of(c, 'title')))}]({parens(text_of(c, 'url'))}), "
                f"accessed {slice_chars(text_of(c, 'accessedAt'), 10)}"
            )
            if published := text_of(c, "publishedAt"):
                s += ", published " + slice_chars(published, 10)
            lines.append(s)
        parts.append("\n".join(lines))
    return "\n\n".join(parts) + "\n"

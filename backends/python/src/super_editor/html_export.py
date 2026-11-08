# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""Static, escaped HTML export (port of packages/core/src/export.ts toHtml).

No scripts, no inline event handlers, no iframes (embeds become links). Links and images are re-checked with
``safe_url``.
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
    num,
    percent,
    rec,
    slice_chars,
    source_line,
    strings,
    table_rows,
    text_of,
)
from .query import Document, get_outline
from .validation import safe_url

_STYLE = (
    "body{font:16px/1.6 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;color:#1f2328}"
    "table{border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #d0d7de;padding:.3rem .6rem}"
    "blockquote{margin:1rem 0;padding-left:1rem;border-left:4px solid #d0d7de;color:#57606a}"
    "pre{background:#f6f8fa;padding:1rem;overflow:auto}"
    "aside.callout{border-left:4px solid #0969da;background:#f6f8fa;padding:.5rem 1rem;margin:1rem 0}"
    "img{max-width:100%}.page-break{break-after:page}.sources{font-size:.9em}figure{margin:1rem 0}"
)

_ESCAPES = str.maketrans({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})


def escape_html(text: str) -> str:
    """Escape text for HTML content and attribute values."""
    return text.translate(_ESCAPES)


def text(value: str) -> str:
    return escape_html(value).replace("\r\n", "<br>").replace("\n", "<br>")


def to_html(doc: Document, *, title: bool = True, standalone: bool = False, chart_rows_limit: int | None = None) -> str:
    """Render a document as HTML. ``standalone`` wraps it in a complete page with a small stylesheet."""
    tree = Tree(doc)
    rows_cap = chart_rows(chart_rows_limit, 100)

    def link(url: str, label: str) -> str:
        safe = safe_url(url, False)
        if safe is not None:
            return f'<a href="{escape_html(safe)}" rel="noopener noreferrer">{label}</a>'
        return label

    def marker(cid: str) -> str:
        label = str(tree.numbers[cid]) if cid in tree.numbers else escape_html(cid)
        return f'<sup class="citation"><a href="#cite-{escape_html(cid)}">[{label}]</a></sup>'

    def runs_html(runs: Sequence[dict[str, Any]]) -> str:
        out: list[str] = []
        for r in runs:
            h = text(r["text"])
            if r.get("code"):
                h = f"<code>{h}</code>"
            if r.get("italic"):
                h = f"<em>{h}</em>"
            if r.get("bold"):
                h = f"<strong>{h}</strong>"
            if r.get("strike"):
                h = f"<s>{h}</s>"
            if r.get("underline"):
                h = f"<u>{h}</u>"
            if r.get("highlight"):
                h = f'<mark data-highlight="{r["highlight"]}">{h}</mark>'
            if r.get("href"):
                h = link(r["href"], h)
            out.append(h)
            if "citationId" in r:
                out.append(marker(r["citationId"]))
        return "".join(out)

    def table(
        head: Sequence[str],
        body: Sequence[Sequence[str]],
        *,
        caption: str = "",
        align: Sequence[str] = (),
        header_column: bool = False,
        omitted: int = 0,
    ) -> str:
        def style(col: int) -> str:
            if col < len(align) and align[col] not in ("", "left"):
                return f' style="text-align:{align[col]}"'
            return ""

        out = ["<table>"]
        if caption:
            out.append(f"<caption>{text(caption)}</caption>")
        out.append("<thead><tr>")
        out.extend(f'<th scope="col"{style(col)}>{text(cell)}</th>' for col, cell in enumerate(head))
        out.append("</tr></thead><tbody>")
        for row in body:
            out.append("<tr>")
            for col, cell in enumerate(row):
                if col == 0 and header_column:
                    out.append(f'<th scope="row"{style(col)}>{text(cell)}</th>')
                else:
                    out.append(f"<td{style(col)}>{text(cell)}</td>")
            out.append("</tr>")
        if omitted > 0:
            out.append(f'<tr><td colspan="{len(head)}">… {omitted} more rows omitted</td></tr>')
        out.append("</tbody></table>")
        return "".join(out)

    def list_html(c: dict[str, Any]) -> str:
        tag = "ol" if is_ordered(c) else "ul"
        todo = text_of(c, "style") == "todo"
        out = [f"<{tag}" + (' class="todo-list"' if todo else "") + ">"]
        previous = 0
        for i, item in enumerate(strings(c.get("items"))):
            level = indent_at(c, i)
            if i > 0:
                if level > previous:
                    out.append(f"<{tag}>" * (level - previous))
                else:
                    out.append("</li>" + f"</{tag}></li>" * (previous - level))
            out.append("<li>")
            if todo:
                out.append('<input type="checkbox" disabled' + (" checked" if checked_at(c, i) else "") + "> ")
            out.append(text(item))
            previous = level
        out.append("</li>" + f"</{tag}></li>" * previous + f"</{tag}>")
        return "".join(out)

    def outline(entries: Sequence[dict[str, Any]]) -> str:
        if not entries:
            return ""
        inner = "".join(
            f'<li><a href="#{escape_html(item["id"])}">{text(item["title"])}</a>{outline(item["children"])}</li>'
            for item in entries
        )
        return f"<ol>{inner}</ol>"

    def render(block: dict[str, Any]) -> str:  # noqa: C901, PLR0912, PLR0915
        c = block["content"]
        kind = c["type"]
        ident = f' id="{escape_html(block["id"])}"'
        kids = "".join(render(child) for child in tree.children.get(block["id"], []))
        h = ""
        if kind == "section":
            h = f"<section{ident}><h2>{text(text_of(c, 'title'))}</h2>{kids}</section>"
        elif kind == "toggle":
            opened = " open" if c.get("open") is True else ""
            h = f"<details{ident}{opened}><summary>{text(text_of(c, 'title'))}</summary>{kids}</details>"
        elif kind == "heading":
            level = num(c["level"])
            h = f"<h{level}{ident}>{text(text_of(c, 'text'))}</h{level}>"
        elif kind == "paragraph":
            h = f"<p{ident}>{runs_html(c['runs'])}</p>"
        elif kind == "list":
            s = list_html(c)
            tag = "ol" if s.startswith("<ol") else "ul"
            h = s.replace(f"<{tag}", f"<{tag}{ident}", 1)
        elif kind == "table":
            s = table(
                strings(c.get("columns")),
                table_rows(c),
                caption=text_of(c, "caption"),
                align=strings(c.get("align")),
                header_column=c.get("headerColumn") is True,
            )
            h = s.replace("<table", f"<table{ident}", 1)
        elif kind == "chart":
            spec = rec(c.get("spec"))
            data = chart_data(spec, rows_cap)
            notes = "".join(
                f'<p class="chart-note">{text(extra)}</p>'
                for extra in (annotation_line(spec), text_of(spec, "caption"), source_line(spec))
                if extra
            )
            h = (
                f'<figure{ident} class="chart" data-kind="{escape_html(text_of(spec, "kind"))}">'
                f"<figcaption>{text(text_of(spec, 'title'))} "
                f"<small>({text(chart_descriptor(spec))})</small></figcaption>"
                + table(data.head, data.rows, omitted=data.omitted)
                + notes
                + "</figure>"
            )
        elif kind == "embed":
            h = f'<p{ident} class="embed">{link(text_of(c, "url"), text(text_of(c, "title")))}</p>'
        elif kind == "timestamp":
            at = escape_html(text_of(c, "at"))
            h = f'<p{ident}><time datetime="{at}">{text(text_of(c, "label"))}: {at}</time></p>'
        elif kind == "quote":
            footer = f"<footer>— {text(text_of(c, 'attribution'))}</footer>" if text_of(c, "attribution") else ""
            h = f"<blockquote{ident}>{runs_html(c['runs'])}{footer}</blockquote>"
        elif kind == "callout":
            heading = f"<strong>{text(text_of(c, 'title'))}</strong>" if text_of(c, "title") else ""
            h = (
                f'<aside{ident} class="callout" data-tone="{text_of(c, "tone")}" role="note">'
                f"{heading}<p>{runs_html(c['runs'])}</p></aside>"
            )
        elif kind == "code":
            language = text_of(c, "language")
            cls = f' class="language-{escape_html(language)}"' if language else ""
            h = f"<pre{ident}><code{cls}>{escape_html(text_of(c, 'text'))}</code></pre>"
        elif kind == "divider":
            h = f"<hr{ident}>"
        elif kind == "pageBreak":
            h = f'<hr{ident} class="page-break">'
        elif kind == "image":
            width = text_of(c, "width") or "normal"
            inner = text(text_of(c, "alt"))
            safe = safe_url(text_of(c, "url"), True)
            if safe is not None:
                inner = (
                    f'<img src="{escape_html(safe)}" alt="{escape_html(text_of(c, "alt"))}" loading="lazy" '
                    'referrerpolicy="no-referrer">'
                )
            caption = f"<figcaption>{text(text_of(c, 'caption'))}</figcaption>" if text_of(c, "caption") else ""
            h = f'<figure{ident} class="image width-{width}">{inner}{caption}</figure>'
        elif kind == "metrics":
            parts: list[str] = []
            for it in items(c.get("items")):
                m = rec(it)
                tone = f' data-tone="{text_of(m, "tone")}"' if text_of(m, "tone") else ""
                change = f' <span class="change">{escape_html(percent(m["change"]))}</span>' if "change" in m else ""
                hint = f'<dd class="hint">{text(text_of(m, "hint"))}</dd>' if text_of(m, "hint") else ""
                parts.append(
                    f'<div class="metric"{tone}><dt>{text(text_of(m, "label"))}</dt>'
                    f"<dd>{text(text_of(m, 'value'))}{change}</dd>{hint}</div>"
                )
            h = f'<dl{ident} class="metrics">{"".join(parts)}</dl>'
        elif kind == "toc":
            h = f'<nav{ident} class="toc" aria-label="Table of contents">{outline(get_outline(doc))}</nav>'
        sources = block_sources(block)
        if sources:
            h += f'<small class="block-sources">Sources: {" ".join(marker(s) for s in sources)}</small>'
        return h

    body = "\n".join(render(block) for block in tree.children.get(None, []))
    sources_html = ""
    citations = items(doc.get("citations"))
    if citations:
        lis: list[str] = []
        for ci in citations:
            c = rec(ci)
            accessed = text_of(c, "accessedAt")
            li = (
                f'<li id="cite-{escape_html(text_of(c, "id"))}">{link(text_of(c, "url"), text(text_of(c, "title")))} '
                f'<small>Accessed <time datetime="{escape_html(accessed)}">'
                f"{escape_html(slice_chars(accessed, 10))}</time>"
            )
            if published := text_of(c, "publishedAt"):
                li += (
                    f' · Published <time datetime="{escape_html(published)}">'
                    f"{escape_html(slice_chars(published, 10))}</time>"
                )
            lis.append(li + "</small></li>")
        sources_html = (
            '\n<section class="sources" aria-label="Sources"><h2>Sources</h2><ol>' + "".join(lis) + "</ol></section>"
        )
    heading = f"\n<h1>{text(text_of(doc, 'title'))}</h1>" if title else ""
    article = (
        f'<article class="se-document" data-document-id="{escape_html(text_of(doc, "id"))}">'
        f"{heading}\n{body}{sources_html}\n</article>"
    )
    if standalone:
        return (
            '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            f"<title>{escape_html(text_of(doc, 'title'))}</title><style>{_STYLE}</style></head><body>\n"
            f"{article}\n</body></html>\n"
        )
    return article + "\n"

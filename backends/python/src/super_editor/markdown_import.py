# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""Block-level markdown import (port of packages/core/src/import.ts fromMarkdown).

ATX headings, paragraphs, bullet, numbered and task lists with nesting, GFM tables, fenced code, block quotes and
GitHub alerts, dividers, page breaks, ``[TOC]`` and https image lines. The reference's line patterns are regular
expressions with backtracking; they are matched by hand here (see the comments for the pattern each one stands for).
"""

from __future__ import annotations

from typing import Any, NamedTuple

from .inline import JS_SPACE, inline_to_plain, js_ltrim, js_rtrim, js_trim, normalize_runs, parse_inline, plain_runs
from .validation import safe_url

Block = dict[str, Any]

_TONES = {
    "NOTE": "info",
    "TIP": "success",
    "IMPORTANT": "note",
    "WARNING": "warning",
    "CAUTION": "danger",
    "INFO": "info",
    "SUCCESS": "success",
    "DANGER": "danger",
}

_PREFIX_ERROR = (
    'fromMarkdown requires an idPrefix that starts with a letter or digit and uses only letters, digits, ".", "_", '
    '":" or "-" (at most 100 characters)'
)


def _is_space(ch: str) -> bool:
    return ch in JS_SPACE


def _leading_spaces(s: str) -> int:
    n = 0
    while n < 3 and n < len(s) and s[n] == " ":
        n += 1
    return n


def _match_fence(line: str) -> tuple[str, str] | None:
    """/^ {0,3}(`{3,}|~{3,})\\s*([^\\s`]*)[^`]*$/ - the fence run and the info word."""
    i = _leading_spaces(line)
    if i >= len(line) or line[i] not in "`~":
        return None
    c = line[i]
    j = i
    while j < len(line) and line[j] == c:
        j += 1
    if j - i < 3 or "`" in line[j:]:
        return None
    k = j
    while k < len(line) and _is_space(line[k]):
        k += 1
    e = k
    while e < len(line) and not _is_space(line[e]):
        e += 1
    return line[i:j], line[k:e]


def _match_heading(line: str) -> tuple[int, str] | None:
    """/^ {0,3}(#{1,6})(?:\\s+(.*?))?(?:\\s+#+)?\\s*$/ - the hash count and the text."""
    i = _leading_spaces(line)
    j = i
    while j < len(line) and line[j] == "#":
        j += 1
    if j == i or j - i > 6:
        return None
    rest = line[j:]
    if not rest:
        return j - i, ""
    if not _is_space(rest[0]):
        return None
    body = js_trim(rest)
    h = len(body)
    while h > 0 and body[h - 1] == "#":
        h -= 1
    if 0 < h < len(body) and _is_space(body[h - 1]):
        return j - i, js_rtrim(body[:h])
    return j - i, body


def _match_break(line: str) -> str | None:
    """/^ {0,3}([-*_])(?:[ \\t]*\\1){2,}[ \\t]*$/ - the character."""
    i = _leading_spaces(line)
    if i >= len(line) or line[i] not in "-*_":
        return None
    c = line[i]
    count = 0
    for ch in line[i:]:
        if ch == c:
            count += 1
        elif ch not in " \t":
            return None
    return c if count >= 3 else None


class _Item(NamedTuple):
    spaces: int
    marker: str
    text: str


def _match_item(line: str) -> _Item | None:
    """/^( *)([-*+]|\\d{1,9}[.)])\\s+(.*)$/"""
    i = 0
    while i < len(line) and line[i] == " ":
        i += 1
    if i >= len(line):
        return None
    j = i
    if line[i] in "-*+":
        j = i + 1
    elif "0" <= line[i] <= "9":
        while j < len(line) and "0" <= line[j] <= "9":
            j += 1
        if j - i > 9 or j >= len(line) or line[j] not in ".)":
            return None
        j += 1
    else:
        return None
    if j >= len(line) or not _is_space(line[j]):
        return None
    k = j
    while k < len(line) and _is_space(line[k]):
        k += 1
    return _Item(i, line[i:j], line[k:])


def _is_dash_cell(p: str) -> bool:
    p = p.removeprefix(":").removesuffix(":")
    return p != "" and p.strip("-") == ""


def _is_table_rule(line: str) -> bool:
    s = js_ltrim(line)
    if s.startswith("|"):
        s = s[1:]
    parts = s.split("|")
    for i, p in enumerate(parts):
        p = js_trim(p)  # noqa: PLW2901
        if p == "" and i == len(parts) - 1 and i > 0:
            continue
        if not _is_dash_cell(p):
            return False
    return True


def _match_image(line: str) -> tuple[str, str] | None:
    """/^!\\[([^\\]]*)\\]\\(<?([^)\\s>]+)>?(?:\\s+"[^"]*")?\\)\\s*$/ - the alt text and the target."""
    if len(line) < 2 or line[0] != "!" or line[1] != "[":
        return None
    i = 2
    while i < len(line) and line[i] != "]":
        i += 1
    if i + 1 >= len(line) or line[i + 1] != "(":
        return None
    alt = line[2:i]
    start = i + 2

    def attempt(frm: int) -> str | None:
        j = frm
        while j < len(line) and line[j] not in ")>" and not _is_space(line[j]):
            j += 1
        if j == frm:
            return None
        target = line[frm:j]
        if j < len(line) and line[j] == ">":
            j += 1
        if j < len(line) and _is_space(line[j]):
            k = j
            while k < len(line) and _is_space(line[k]):
                k += 1
            if k < len(line) and line[k] == '"':
                e = k + 1
                while e < len(line) and line[e] != '"':
                    e += 1
                if e < len(line):
                    j = e + 1
        if j >= len(line) or line[j] != ")":
            return None
        if any(not _is_space(ch) for ch in line[j + 1 :]):
            return None
        return target

    if start < len(line) and line[start] == "<":
        url = attempt(start + 1)
        if url is not None:
            return alt, url
    url = attempt(start)
    return (alt, url) if url is not None else None


def _match_footnote_definition(line: str) -> bool:
    if not line.startswith("[^"):
        return False
    s = line[2:]
    i = 0
    while i < len(s) and s[i] != "]":
        i += 1
    return i > 0 and i + 2 < len(s) and s[i] == "]" and s[i + 1] == ":" and _is_space(s[i + 2])


def _starts_block(text: str, nxt: str | None) -> bool:  # noqa: C901
    """Whether a line starts a new block and so ends the paragraph or list item before it."""
    if _match_fence(text) is not None:
        return True
    i = _leading_spaces(text)
    if i < len(text) and text[i] == "#":
        j = i
        while j < len(text) and text[j] == "#":
            j += 1
        if j - i <= 6 and (j >= len(text) or _is_space(text[j])):
            return True
    if i < len(text) and text[i] == ">":
        return True
    if _match_break(text) is not None:
        return True
    if i + 1 < len(text):
        c = text[i]
        if c in "-*+" and _is_space(text[i + 1]):
            return True
        if c == "1" and i + 2 < len(text) and text[i + 1] in ".)" and _is_space(text[i + 2]):
            return True
    if _match_image(js_trim(text)) is not None:
        return True
    return "|" in text and nxt is not None and _is_table_rule(nxt) and "|" in nxt


def _split_row(row: str) -> list[str]:
    cells: list[str] = []
    current: list[str] = []
    i = 0
    while i < len(row):
        if row[i] == "\\" and i + 1 < len(row) and row[i + 1] == "|":
            current.append("|")
            i += 1
        elif row[i] == "|":
            cells.append("".join(current))
            current = []
        else:
            current.append(row[i])
        i += 1
    cells.append("".join(current))
    if cells and js_trim(cells[0]) == "":
        cells = cells[1:]
    if cells and js_trim(cells[-1]) == "":
        cells = cells[:-1]
    return [js_trim(c) for c in cells]


def _valid_prefix(p: str) -> bool:
    if not p or len(p) > 100:
        return False
    for i, ch in enumerate(p):
        ok = ch.isascii() and ch.isalnum()
        if i > 0:
            ok = ok or ch in "._:-"
        if not ok:
            return False
    return True


def _is_toc(line: str) -> bool:
    return js_trim(line).lower() in ("[toc]", "[[toc]]", "[[toc]", "[toc]]")


def _split_paragraphs(rows: list[str]) -> list[str]:
    """``rows.join('\\n').split(/\\n\\s*\\n/)`` with every piece trimmed per line, joined by spaces and non-empty."""
    text = "\n".join(rows)
    pieces: list[str] = []
    start = 0
    i = 0
    while i < len(text):
        if text[i] != "\n":
            i += 1
            continue
        last = -1
        k = i + 1
        while k < len(text) and _is_space(text[k]):
            if text[k] == "\n":
                last = k
            k += 1
        if last < 0:
            i += 1
            continue
        pieces.append(text[start:i])
        start = last + 1
        i = last + 1
    pieces.append(text[start:])
    out: list[str] = []
    for piece in pieces:
        joined = js_trim(" ".join(js_trim(part) for part in piece.split("\n")))
        if joined:
            out.append(joined)
    return out


def _is_language(info: str) -> bool:
    return all((ch.isascii() and ch.isalnum()) or ch in "+#._-" for ch in info)


def _closes_fence(line: str, marker: str) -> bool:
    i = _leading_spaces(line)
    j = i
    while j < len(line) and line[j] == marker[0]:
        j += 1
    if j - i < len(marker):
        return False
    return all(_is_space(ch) for ch in line[j:])


def _is_quote_line(line: str) -> bool:
    i = _leading_spaces(line)
    return i < len(line) and line[i] == ">"


def _strip_quote(line: str) -> str:
    i = _leading_spaces(line) + 1
    if i < len(line) and line[i] == " ":
        i += 1
    return line[i:]


def _alert_name(s: str) -> str | None:
    t = js_rtrim(s)
    if not t.startswith("[!") or not t.endswith("]"):
        return None
    name = t[2:-1]
    if not name or not all(ch.isascii() and ch.isalpha() for ch in name):
        return None
    return name


def _bold_title(s: str) -> str | None:
    t = js_rtrim(s)
    if not t.startswith("**") or not t.endswith("**") or len(t) < 5:
        return None
    inner = t[2:-2]
    return None if inner == "" or "*" in inner else inner


def _attribution_of(s: str) -> str | None:
    """/^(?:—|--)\\s+(.+)$/"""
    if s.startswith("—"):
        rest = s[1:]
    elif s.startswith("--"):
        rest = s[2:]
    else:
        return None
    trimmed = js_ltrim(rest)
    if len(trimmed) == len(rest):
        return None
    if trimmed == "":
        # \s+ gives one whitespace character back to (.+)
        return rest[-1:] if len(rest) >= 2 else None
    return trimmed


def _has_checkbox(text: str) -> tuple[bool, str] | None:
    """/^\\[([ xX])\\]\\s+(.*)$/ - whether it is checked, and the rest."""
    if len(text) < 4 or text[0] != "[" or text[2] != "]" or text[1] not in " xX":
        return None
    after = text[3:]
    if not after or not _is_space(after[0]):
        return None
    return text[1] != " ", js_ltrim(after)


def _is_todo_start(text: str) -> bool:
    return len(text) >= 4 and text[0] == "[" and text[2] == "]" and text[1] in " xX" and _is_space(text[3])


def _is_digit(ch: str) -> bool:
    return "0" <= ch <= "9"


class _Importer:
    def __init__(self, prefix: str, parent_id: str | None, citation_markers: bool) -> None:
        self.prefix = prefix
        self.parent: str | None = parent_id or None
        self.citation_markers = citation_markers
        self.result: list[Block] = []

    def emit(self, content: dict[str, Any]) -> None:
        self.result.append(
            {
                "id": f"{self.prefix}-{len(self.result) + 1}",
                "parentId": self.parent,
                "content": content,
                "citationIds": [],
            }
        )

    def inline(self, text: str) -> list[dict[str, Any]]:
        parsed = parse_inline(text)
        if not self.citation_markers:
            parsed = normalize_runs(
                [{"text": "[^" + r["citationId"] + "]"} if "citationId" in r and r["text"] == "" else r for r in parsed]
            )
        return parsed

    def quote(self, inner: list[str]) -> None:
        name = _alert_name(inner[0]) if inner else None
        if name is not None and name.upper() in _TONES:
            skip = 1
            content: dict[str, Any] = {"type": "callout", "tone": _TONES[name.upper()]}
            if len(inner) > 1:
                title = _bold_title(inner[1])
                if title is not None:
                    content["title"] = title
                    skip = 2
            content["runs"] = self.inline("\n\n".join(_split_paragraphs(inner[skip:])))
            self.emit(content)
            return
        body = _split_paragraphs(inner)
        content = {"type": "quote"}
        if body:
            attribution = _attribution_of(body[-1])
            if attribution is not None:
                body = body[:-1]
                content["attribution"] = inline_to_plain(attribution)
        content["runs"] = self.inline("\n\n".join(body))
        self.emit(content)

    def table(self, lines: list[str], index: int) -> int:
        columns = [inline_to_plain(c) for c in _split_row(lines[index])]
        rule = _split_row(lines[index + 1])
        alignment: list[str] = []
        for cell in rule:
            if len(cell) > 2 and cell.startswith(":") and cell.endswith(":") and cell[1:-1].strip("-") == "":
                alignment.append("center")
            elif cell.endswith("-:"):
                alignment.append("right")
            elif cell.startswith(":-"):
                alignment.append("left")
            else:
                alignment.append("")
        rows: list[list[str]] = []
        index += 2
        while index < len(lines) and js_trim(lines[index]) != "" and "|" in lines[index]:
            cells = [inline_to_plain(c) for c in _split_row(lines[index])]
            index += 1
            rows.append([cells[c] if c < len(cells) else "" for c in range(len(columns))])
        content: dict[str, Any] = {"type": "table", "columns": columns, "rows": rows}
        if any(alignment):
            content["align"] = [
                alignment[c] if c < len(alignment) and alignment[c] else "left" for c in range(len(columns))
            ]
        self.emit(content)
        return index

    def list_(self, lines: list[str], index: int, first: _Item) -> int:  # noqa: C901, PLR0912
        items: list[str] = []
        checked_list: list[bool] = []
        levels: list[int] = []
        stack: list[int] = []
        ordered = _is_digit(first.marker[0])
        todo = _is_todo_start(first.text)
        while index < len(lines):
            current = lines[index]
            if js_trim(current) == "":
                nxt = index + 1
                while nxt < len(lines) and js_trim(lines[nxt]) == "":
                    nxt += 1
                if nxt < len(lines):
                    upcoming = _match_item(lines[nxt])
                    if (
                        upcoming is not None
                        and _match_break(lines[nxt]) is None
                        and (upcoming.spaces > 0 or _is_digit(upcoming.marker[0]) == ordered)
                    ):
                        index = nxt
                        continue
                break
            it = _match_item(current)
            if it is not None and _match_break(current) is None:
                if it.spaces == 0 and _is_digit(it.marker[0]) != ordered and items:
                    break
                while len(stack) > 1 and it.spaces < stack[-1]:
                    stack.pop()
                if not stack or it.spaces > stack[-1]:
                    stack.append(it.spaces)
                box = _has_checkbox(it.text) if todo else None
                levels.append(min(3, len(stack) - 1))
                checked_list.append(box is not None and box[0])
                items.append(inline_to_plain(box[1] if box is not None else it.text))
                index += 1
                continue
            # Anything that does not start a new block continues the previous item (indented or lazy).
            nxt_line = lines[index + 1] if index + 1 < len(lines) else None
            if items and not _starts_block(current, nxt_line):
                items[-1] += " " + inline_to_plain(js_trim(current))
                index += 1
                continue
            break
        content: dict[str, Any] = {"type": "list", "ordered": ordered and not todo, "items": items}
        if todo:
            content["style"] = "todo"
            content["checked"] = checked_list
        if any(level > 0 for level in levels):
            content["indent"] = levels
        self.emit(content)
        return index

    def paragraph(self, lines: list[str], index: int) -> int:
        body: list[str] = []
        while index < len(lines) and js_trim(lines[index]) != "":
            nxt = lines[index + 1] if index + 1 < len(lines) else None
            if body and _starts_block(lines[index], nxt):
                break
            body.append(lines[index])
            index += 1
        joined: list[str] = []
        for position, row in enumerate(body):
            last = position == len(body) - 1
            trimmed = js_ltrim(row)
            if not last and row.endswith("\\"):
                joined.append(trimmed.removesuffix("\\") + "\n")
            elif not last and row.endswith("  "):
                joined.append(trimmed.rstrip(" ") + "\n")
            elif last:
                joined.append(js_rtrim(trimmed))
            else:
                joined.append(js_rtrim(trimmed) + " ")
        text = "".join(joined)
        if _match_footnote_definition(body[0]):
            self.emit({"type": "paragraph", "runs": plain_runs(text)})
        elif js_trim(text) != "":
            self.emit({"type": "paragraph", "runs": self.inline(text)})
        return index

    def run(self, markdown: str) -> list[Block]:  # noqa: C901, PLR0912
        lines = markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        index = 0
        while index < len(lines):
            text = lines[index]
            if js_trim(text) == "":
                index += 1
                continue
            fence = _match_fence(text)
            if fence is not None:
                marker, info = fence
                body: list[str] = []
                index += 1
                while index < len(lines) and not _closes_fence(lines[index], marker):
                    body.append(lines[index])
                    index += 1
                index += 1
                language = info[:40] if _is_language(info) else ""
                self.emit({"type": "code", "language": language, "text": "\n".join(body)})
                continue
            heading = _match_heading(text)
            if heading is not None:
                self.emit({"type": "heading", "level": min(3, heading[0]), "text": inline_to_plain(heading[1])})
                index += 1
                continue
            rule = _match_break(text)
            if rule is not None:
                self.emit({"type": "pageBreak" if rule == "*" else "divider"})
                index += 1
                continue
            if _is_toc(text):
                self.emit({"type": "toc"})
                index += 1
                continue
            image = _match_image(js_trim(text))
            if image is not None and text[_leading_spaces(text) : _leading_spaces(text) + 1] == "!":
                safe = safe_url(image[1], True)
                if safe is not None:
                    self.emit({"type": "image", "url": safe, "alt": image[0]})
                    index += 1
                    continue
            if _is_quote_line(text):
                inner: list[str] = []
                while index < len(lines) and _is_quote_line(lines[index]):
                    inner.append(_strip_quote(lines[index]))
                    index += 1
                self.quote(inner)
                continue
            first = _match_item(text)
            if first is not None:
                index = self.list_(lines, index, first)
                continue
            if "|" in text and index + 1 < len(lines) and _is_table_rule(lines[index + 1]) and "|" in lines[index + 1]:
                index = self.table(lines, index)
                continue
            index = self.paragraph(lines, index)
        return self.result


def from_markdown(
    markdown: str, *, id_prefix: str, parent_id: str | None = None, citation_markers: bool = True
) -> list[Block]:
    """Convert block-level markdown to blocks. Block IDs are ``<id_prefix>-1``, ``<id_prefix>-2``, ... in document
    order; every block gets ``parent_id`` as its parent. With ``citation_markers=False`` ``[^id]`` stays text.
    Raises ``ValueError`` when the ID prefix is not usable."""
    if not _valid_prefix(id_prefix):
        raise ValueError(_PREFIX_ERROR)
    return _Importer(id_prefix, parent_id, citation_markers).run(markdown)

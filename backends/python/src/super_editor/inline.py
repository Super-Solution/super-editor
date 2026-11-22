# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""Inline markdown-lite: **bold**, *italic* / _italic_, ~~strike~~, `code`, [label](https://url) and [^citation-id].

A port of packages/core/src/inline.ts; conformance/render.v1.json pins every behaviour. Runs are dicts like
``{"text": "x", "bold": True, "href": "https://..."}``. The reference works on UTF-16 strings; here text is processed
by code point, which agrees for the Basic Multilingual Plane and differs only in how astral characters count against
the parser's size limits.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from .validation import safe_url

# JavaScript's \s: WhiteSpace and LineTerminator.
JS_SPACE = frozenset("\t\n\x0b\x0c\r \xa0                　﻿")
LINE_TERMINATORS = frozenset("\n\r  ")
ESCAPABLE = frozenset("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")
MAX_DEPTH = 6

Run = dict[str, Any]


def js_trim(text: str) -> str:
    return js_rtrim(js_ltrim(text))


def js_ltrim(text: str) -> str:
    i = 0
    while i < len(text) and text[i] in JS_SPACE:
        i += 1
    return text[i:]


def js_rtrim(text: str) -> str:
    j = len(text)
    while j > 0 and text[j - 1] in JS_SPACE:
        j -= 1
    return text[:j]


def _is_word(ch: str) -> bool:
    """A letter or number, tested on one UTF-16 code unit: astral characters are surrogate halves there."""
    return ord(ch) <= 0xFFFF and unicodedata.category(ch)[0] in "LN"


def _space_at(src: str, i: int) -> bool:
    return i < 0 or i >= len(src) or src[i] in JS_SPACE


def _word_at(src: str, i: int) -> bool:
    return 0 <= i < len(src) and _is_word(src[i])


def plain_runs(text: str) -> list[Run]:
    return [] if text == "" else [{"text": text}]


_FORMAT_KEYS = ("bold", "italic", "code", "href", "strike", "underline", "highlight")


def _same_format(a: Run, b: Run) -> bool:
    return all(a.get(k) == b.get(k) for k in _FORMAT_KEYS) and "citationId" not in a and "citationId" not in b


def normalize_runs(runs: list[Run]) -> list[Run]:
    """Merge neighbours with identical formatting and drop empty runs (citation markers excepted)."""
    out: list[Run] = []
    for run in runs:
        if run["text"] == "" and "citationId" not in run:
            continue
        if out and _same_format(out[-1], run):
            out[-1]["text"] += run["text"]
        else:
            out.append(dict(run))
    return out


def _backtick_run(src: str, i: int) -> int:
    n = 0
    while i + n < len(src) and src[i + n] == "`":
        n += 1
    return n


def _find_backticks(src: str, start: int, count: int, ctx: list[int]) -> int:
    i = start
    while i < len(src):
        ctx[0] -= 1
        if ctx[0] < 0:
            return -1
        if src[i] != "`":
            i += 1
            continue
        n = _backtick_run(src, i)
        if n == count:
            return i
        i += n
    return -1


def _can_open(src: str, i: int, delim: str) -> bool:
    if _space_at(src, i + len(delim)):
        return False
    return delim != "_" or not _word_at(src, i - 1)


def _can_close(src: str, i: int, delim: str) -> bool:
    if _space_at(src, i - 1):
        return False
    return delim != "_" or not _word_at(src, i + 1)


def _find_close(src: str, start: int, delim: str, ctx: list[int]) -> int:
    i = start
    while i < len(src):
        ctx[0] -= 1
        if ctx[0] < 0:
            return -1
        ch = src[i]
        if ch == "\\":
            i += 2
            continue
        if ch == "`":
            n = _backtick_run(src, i)
            close = _find_backticks(src, i + n, n, ctx)
            i = close + n if close >= 0 else i + n
            continue
        if not src.startswith(delim, i):
            i += 1
            continue
        if len(delim) == 1 and src[i + 1 : i + 2] == delim:
            i += 2
            continue
        if _can_close(src, i, delim):
            return i
        i += 1
    return -1


def _match_bracket(src: str, open_at: int, ctx: list[int]) -> int:
    depth = 0
    i = open_at
    while i < len(src) and i < open_at + 2000:
        ctx[0] -= 1
        if ctx[0] < 0:
            return -1
        ch = src[i]
        if ch == "\\":
            i += 2
            continue
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


_DELIMITERS: tuple[tuple[str, dict[str, bool]], ...] = (
    ("***", {"bold": True, "italic": True}),
    ("**", {"bold": True}),
    ("~~", {"strike": True}),
    ("*", {"italic": True}),
    ("_", {"italic": True}),
)


def _is_citation_char(ch: str, first: bool) -> bool:
    if ("a" <= ch <= "z") or ("A" <= ch <= "Z") or ("0" <= ch <= "9"):
        return True
    return not first and ch in "._:-"


def _citation_marker(src: str) -> tuple[str, int] | None:
    """Match ``^\\[\\^([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\\]`` at the start of src."""
    if len(src) < 4 or src[0] != "[" or src[1] != "^":
        return None
    i = 2
    while i < len(src) and i - 2 < 128 and _is_citation_char(src[i], i == 2):
        i += 1
    if i == 2 or i >= len(src) or src[i] != "]":
        return None
    return src[2:i], i + 1


def _link_target(text: str) -> str:
    """``trim().split(/\\s+/u)[0].replace(/^<|>$/g, '')``."""
    t = js_trim(text)
    for i, ch in enumerate(t):
        if ch in JS_SPACE:
            t = t[:i]
            break
    if t.startswith("<"):
        t = t[1:]
    if t.endswith(">"):
        t = t[:-1]
    return t


def _parse(src: str, marks: dict[str, Any], depth: int, out: list[Run], ctx: list[int]) -> None:  # noqa: C901, PLR0912
    buffer: list[str] = []

    def flush() -> None:
        if buffer:
            out.append({"text": "".join(buffer), **marks})
        buffer.clear()

    i = 0
    while i < len(src):
        ch = src[i]
        if ch == "\\" and i + 1 < len(src) and src[i + 1] in ESCAPABLE:
            buffer.append(src[i + 1])
            i += 2
            continue
        if ch == "`":
            n = _backtick_run(src, i)
            close = _find_backticks(src, i + n, n, ctx)
            if close >= 0:
                code = src[i + n : close]
                if len(code) > 1 and code.startswith(" ") and code.endswith(" ") and js_trim(code):
                    code = code[1:-1]
                flush()
                out.append({"text": code, **marks, "code": True})
                i = close + n
                continue
            buffer.append("`" * n)
            i += n
            continue
        if ch == "[":
            marker = _citation_marker(src[i : i + 134])
            if marker:
                flush()
                out.append({"text": "", "citationId": marker[0]})
                i += marker[1]
                continue
        image_link = ch == "!" and src[i + 1 : i + 2] == "["
        if (ch == "[" or image_link) and depth < MAX_DEPTH:
            open_at = i + 1 if image_link else i
            close = _match_bracket(src, open_at, ctx)
            if close > 0 and src[close + 1 : close + 2] == "(":
                end = src[close + 2 : close + 4200].find(")")
                if end >= 0:
                    target = _link_target(src[close + 2 : close + 2 + end])
                    href = safe_url(target)
                    if href:
                        flush()
                        _parse(src[open_at + 1 : close] or href, {**marks, "href": href}, depth + 1, out, ctx)
                        i = close + 2 + end + 1
                        continue
        if depth < MAX_DEPTH:
            matched = False
            for token, added in _DELIMITERS:
                if not src.startswith(token, i) or not _can_open(src, i, token):
                    continue
                close = _find_close(src, i + len(token), token, ctx)
                if close <= i + len(token):
                    continue
                flush()
                _parse(src[i + len(token) : close], {**marks, **added}, depth + 1, out, ctx)
                i = close + len(token)
                matched = True
                break
            if matched:
                continue
        buffer.append(ch)
        i += 1
    flush()


def parse_inline(markdown: str) -> list[Run]:
    """Parse inline markdown-lite into runs. Unmatched markers stay literal text, so arbitrary prose is safe."""
    out: list[Run] = []
    _parse(markdown, {}, 0, out, [2_000_000])
    return normalize_runs(out)


# --- serialization -------------------------------------------------------------------------------------------------


def escape_inline(text: str) -> str:
    """Escape inline markdown specials. Line-start constructs are escaped separately by ``escape_line_starts``."""
    first = "".join("\\" + ch if ch in "\\`*_~[]<" else ch for ch in text)
    out: list[str] = []
    for i, ch in enumerate(first):
        if ch == "&":
            j = i + 1
            if j < len(first) and first[j] == "#":
                j += 1
            k = j
            while k < len(first) and (first[k].isascii() and (first[k].isalnum() or first[k] == "_")):
                k += 1
            if k > j and k < len(first) and first[k] == ";":
                out.append("\\")
        out.append(ch)
    return "".join(out)


def _line_starts(src: str) -> list[int]:
    return [0] + [i + 1 for i, ch in enumerate(src) if ch in LINE_TERMINATORS]


def _at_line_end(src: str, i: int) -> bool:
    return i >= len(src) or src[i] in LINE_TERMINATORS


def _spaces_at(src: str, i: int) -> int:
    n = 0
    while n < 3 and i + n < len(src) and src[i + n] == " ":
        n += 1
    return n


def _insert_backslashes(src: str, at: list[int]) -> str:
    if not at:
        return src
    marks = set(at)
    return "".join(("\\" + ch) if i in marks else ch for i, ch in enumerate(src))


def _space_or_end(src: str, i: int) -> bool:
    return _at_line_end(src, i) or src[i] in JS_SPACE


def escape_heading_text(text: str) -> str:
    """``escape_inline`` for text after an ATX marker.

    A trailing ``#`` run after a space would read back as a closing sequence and vanish.
    """
    escaped = escape_inline(text)
    body = escaped.rstrip("#")
    if len(body) == len(escaped) or (body and body[-1] not in JS_SPACE):
        return escaped
    return body + "\\#" * (len(escaped) - len(body))


def escape_line_starts(text: str) -> str:  # noqa: C901
    """Escape constructs that would start a block at the beginning of a line."""
    src = text
    at: list[int] = []
    for start in _line_starts(src):
        p = start + _spaces_at(src, start)
        if p >= len(src):
            continue
        if src[p] == "#":
            n = 0
            while p + n < len(src) and src[p + n] == "#":
                n += 1
            if n <= 6 and _space_or_end(src, p + n):
                at.append(p)
        elif src[p] == ">" or (src[p] in "-+" and _space_or_end(src, p + 1)):
            at.append(p)
    src = _insert_backslashes(src, at)
    at = []
    for start in _line_starts(src):
        p = start + _spaces_at(src, start)
        q = p
        while q < len(src) and "0" <= src[q] <= "9":
            q += 1
        if q > p and q < len(src) and src[q] in ".)" and _space_or_end(src, q + 1):
            at.append(q)
    src = _insert_backslashes(src, at)
    at = []
    for start in _line_starts(src):
        p = start + _spaces_at(src, start)
        if p >= len(src) or src[p] not in "=-":
            continue
        q = p + 1
        while q < len(src) and src[q] in "=-":
            q += 1
        k = q
        while not _at_line_end(src, k) and src[k] in JS_SPACE:
            k += 1
        if _at_line_end(src, k):
            at.append(p)
    src = _insert_backslashes(src, at)
    # A thematic break written with spaces ("--- ---").
    at = []
    for start in _line_starts(src):
        p = start + _spaces_at(src, start)
        if p >= len(src) or src[p] != "-":
            continue
        k = p + 1
        while k < len(src) and src[k] in "- \t":
            k += 1
        if _at_line_end(src, k):
            at.append(p)
    src = _insert_backslashes(src, at)
    # A table delimiter row ("|---|:--:|") turns the line above it into a table header.
    at = []
    for start in _line_starts(src):
        p = start
        while p < len(src) and _is_hspace(src[p]):
            p += 1
        if _is_table_rule_line(src, p):
            at.append(p)
    return _insert_backslashes(src, at)


def _is_hspace(ch: str) -> bool:
    return ch in JS_SPACE and ch not in "\n\r\u2028\u2029"


def _is_table_rule_line(src: str, p: int) -> bool:
    """A table delimiter row from p (dash cells with optional colons, pipes between) with a pipe on the line."""
    n = len(src)

    def skip(i: int) -> int:
        while i < n and _is_hspace(src[i]):
            i += 1
        return i

    pipes = 0
    i = p
    if i < n and src[i] == "|":
        pipes += 1
        i += 1
    i = skip(i)
    while True:
        if i < n and src[i] == ":":
            i += 1
        dashes = 0
        while i < n and src[i] == "-":
            i += 1
            dashes += 1
        if dashes == 0:
            return False
        if i < n and src[i] == ":":
            i += 1
        i = skip(i)
        if i < n and src[i] == "|":
            pipes += 1
            i += 1
            i = skip(i)
            if _at_line_end(src, i):
                return pipes > 0
            continue
        return _at_line_end(src, i) and pipes > 0


def _code_span(text: str) -> str:
    longest = cur = 0
    for ch in text:
        if ch == "`":
            cur += 1
            longest = max(longest, cur)
        else:
            cur = 0
    fence = "`" * (longest + 1)
    if text.startswith("`") or text.endswith("`"):
        return f"{fence} {text} {fence}"
    return f"{fence}{text}{fence}"


_BLANK_LINES = re.compile(r"\n(?:[ \t]*\n)+")


def _hard_breaks(text: str) -> str:
    return text.replace("\n", "  \n")


def parens(url: str) -> str:
    return url.replace("(", "%28").replace(")", "%29")


def runs_to_markdown(runs: list[Run]) -> str:
    """Serialize runs. Underline and highlight have no markdown form and are dropped."""
    out: list[str] = []
    for run in normalize_runs(runs):
        text = run["text"]
        if text != "":
            core = js_trim(text)
            if core:
                lead, trail = text[: len(text) - len(js_ltrim(text))], text[len(js_rtrim(text)) :]
            else:
                lead, trail = text, ""
            inner = _code_span(core) if run.get("code") else _hard_breaks(escape_inline(core))
            if core:
                if run.get("strike"):
                    inner = f"~~{inner}~~"
                if run.get("bold") and run.get("italic"):
                    inner = f"***{inner}***"
                elif run.get("bold"):
                    inner = f"**{inner}**"
                elif run.get("italic"):
                    inner = f"*{inner}*"
                if run.get("href"):
                    inner = f"[{inner}]({parens(run['href'])})"
            out.append(_hard_breaks(lead) + inner + _hard_breaks(trail))
        if "citationId" in run:
            out.append(f"[^{run['citationId']}]")
    # A blank line ends a paragraph in Markdown: consecutive line breaks collapse into one hard break.
    return _BLANK_LINES.sub("\n", "".join(out))


def inline_to_plain(markdown: str) -> str:
    """Plain text of a markdown-lite string, for list items and table cells. Link targets are kept in parentheses."""
    return "".join(
        f"{run['text']} ({run['href']})" if run.get("href") and run["text"] != run["href"] else run["text"]
        for run in parse_inline(markdown)
    )

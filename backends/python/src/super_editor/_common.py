# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""Helpers shared by the Markdown, HTML and plain-text exporters."""

from __future__ import annotations

import math
from collections.abc import Mapping
from decimal import Decimal
from typing import Any, NamedTuple

from .inline import JS_SPACE, js_trim
from .query import Block, Document, blocks_of, child_index


def js_number(value: float) -> str:
    """Format a number the way JavaScript's ``String(number)`` does."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        if abs(value) < 10**21:
            return str(value)
        value = float(value)
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    _, digit_tuple, exponent = Decimal(repr(abs(value))).as_tuple()
    digit_list = list(digit_tuple)
    assert isinstance(exponent, int)
    while len(digit_list) > 1 and digit_list[-1] == 0:
        digit_list.pop()
        exponent += 1
    while len(digit_list) > 1 and digit_list[0] == 0:
        digit_list.pop(0)
    digits = "".join(map(str, digit_list))
    k, n = len(digits), len(digits) + exponent  # value = 0.digits x 10^n
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * -n + digits
    expo = n - 1
    sign_char = "+" if expo >= 0 else "-"
    mantissa = digits if k == 1 else digits[0] + "." + digits[1:]
    return f"{sign}{mantissa}e{sign_char}{abs(expo)}"


def num(value: Any) -> str:
    return js_number(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else ""


def text_of(m: Mapping[str, Any], key: str) -> str:
    value = m.get(key)
    return value if isinstance(value, str) else ""


def rec(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def items(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def strings(value: Any) -> list[str]:
    return [s if isinstance(s, str) else "" for s in items(value)]


class Tree:
    def __init__(self, doc: Document) -> None:
        self.doc = doc
        self.children = child_index(blocks_of(doc))
        self.numbers = {rec(c).get("id"): i + 1 for i, c in enumerate(items(doc.get("citations")))}


def line(text: str) -> str:
    """Collapse every whitespace run that holds a newline into one space, then trim."""
    out: list[str] = []
    i = 0
    while i < len(text):
        if text[i] not in JS_SPACE:
            out.append(text[i])
            i += 1
            continue
        j = i
        while j < len(text) and text[j] in JS_SPACE:
            j += 1
        out.append(" " if "\n" in text[i:j] else text[i:j])
        i = j
    return js_trim("".join(out))


def block_sources(block: Block) -> list[str]:
    """Block-level citations that are not already marked inline inside the same block."""
    inline = {run["citationId"] for run in block["content"].get("runs") or [] if "citationId" in run}
    return [cid for cid in strings(block.get("citationIds")) if cid not in inline]


def percent(value: Any) -> str:
    sign = "+" if isinstance(value, (int, float)) and value > 0 else ""
    return f"{sign}{num(value)}%"


def is_ordered(content: Mapping[str, Any]) -> bool:
    style = text_of(content, "style")
    if style:
        return style == "number"
    return content.get("ordered") is True


def indent_at(content: Mapping[str, Any], i: int) -> int:
    indent = items(content.get("indent"))
    return int(indent[i]) if i < len(indent) and isinstance(indent[i], (int, float)) else 0


def checked_at(content: Mapping[str, Any], i: int) -> bool:
    checked = items(content.get("checked"))
    return i < len(checked) and checked[i] is True


def table_rows(content: Mapping[str, Any]) -> list[list[str]]:
    return [strings(r) for r in items(content.get("rows"))]


def chart_rows(n: int | None, fallback: int) -> int:
    return fallback if n is None or n == 0 else n


class ChartTable(NamedTuple):
    head: list[str]
    rows: list[list[str]]
    omitted: int


def _value_at(values: list[Any], index: int) -> str:
    return num(values[index]) if index < len(values) else ""


def _label_or(value: Any, fallback: str) -> str:
    return value if isinstance(value, str) else fallback


def chart_data(spec: Mapping[str, Any], max_rows: int) -> ChartTable:
    """The data table every non-visual export shows for a chart, limited to ``max_rows`` rows."""
    kind = text_of(spec, "kind")
    ohlc, points, series = items(spec.get("ohlc")), items(spec.get("points")), items(spec.get("series"))
    head: list[str]
    rows: list[list[str]] = []
    if kind == "candlestick" and ohlc:
        volume = any("v" in rec(c) for c in ohlc)
        head = ["Time", "Open", "High", "Low", "Close"] + (["Volume"] if volume else [])
        for item in ohlc:
            c = rec(item)
            row = [text_of(c, "t"), num(c.get("o")), num(c.get("h")), num(c.get("l")), num(c.get("c"))]
            if volume:
                row.append(num(c["v"]) if "v" in c else "")
            rows.append(row)
    elif kind == "scatter" and points:
        head = ["Series", _label_or(spec.get("xLabel"), "x"), _label_or(rec(spec.get("yAxis")).get("label"), "y")]
        rows = [[text_of(rec(p), "series"), num(rec(p).get("x")), num(rec(p).get("y"))] for p in points]
    elif kind == "heatmap" and spec.get("matrix") is not None:
        matrix = rec(spec["matrix"])
        head = ["", *strings(matrix.get("columns"))]
        values = items(matrix.get("values"))
        for i, name in enumerate(strings(matrix.get("rows"))):
            rows.append([name, *(num(v) for v in items(values[i]))] if i < len(values) else [name])
    else:
        head = [_label_or(spec.get("xLabel"), ""), *(text_of(rec(s), "name") for s in series)]
        for i, label in enumerate(strings(spec.get("labels"))):
            rows.append([label, *(_value_at(items(rec(s).get("values")), i) for s in series)])
    omitted = 0
    if len(rows) > max_rows:
        omitted = len(rows) - max_rows
        rows = rows[:max_rows]
    return ChartTable(head, rows, omitted)


def chart_descriptor(spec: Mapping[str, Any]) -> str:
    out = text_of(spec, "kind") + " chart"
    if unit := text_of(spec, "unit"):
        out += ", " + unit
    if as_of := text_of(spec, "asOf"):
        out += ", as of " + as_of
    return out


def source_line(spec: Mapping[str, Any]) -> str:
    source = text_of(spec, "source")
    return "Source: " + source if source else ""


def annotation_line(spec: Mapping[str, Any]) -> str:
    notes = items(spec.get("annotations"))
    if not notes:
        return ""
    parts = []
    for n in notes:
        note = rec(n)
        value = ", " + num(note["value"]) if "value" in note else ""
        parts.append(f"{text_of(note, 'label')} ({text_of(note, 'at')}{value})")
    return "Notes: " + "; ".join(parts)


def slice_chars(text: str, n: int) -> str:
    return text[:n]

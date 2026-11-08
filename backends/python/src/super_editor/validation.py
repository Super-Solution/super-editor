# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""Validation of documents, transactions and actors, in Python.

A port of packages/core/src/validation.ts. Inputs are decoded JSON; each function returns
``{"ok": True, "value": ...}`` with the normalized value, or ``{"ok": False, "issues": [issue]}`` with the first
problem found (the reference stops at the first failure), including its message, path and hint.
conformance/validation.v1.json is the shared test data.

Known differences from the reference, all in the safe direction (a value the reference accepts may be refused,
never the other way round):

* ``safe_url`` refuses IPv6 hosts, non-ASCII (IDN) hosts, ``xn--`` labels, userinfo other than empty, and IPv4
  hosts that are not canonical dotted decimal. The reference normalizes those; the data marks them ``portRejects``.
* The serialized-size budgets (8,000,000 characters) measure compact JSON with Python's number formatting, so
  they can differ from JavaScript's by a few characters at the exact boundary.
"""

from __future__ import annotations

import math
import re
from typing import Any, NoReturn

LIMITS: dict[str, int | float] = {
    "blocks": 5_000,
    "depth": 64,
    "operations": 256,
    "citations": 2_000,
    "text": 100_000,
    "chartPoints": 20_000,
    "chartMagnitude": 1e15,
    "json": 8_000_000,
    "blocksPerOperation": 500,
    "runs": 1_000,
    "listItems": 2_000,
    "listItemText": 10_000,
    "listIndent": 3,
    "tableColumns": 100,
    "tableRows": 2_000,
    "tableCells": 20_000,
    "tableCellText": 10_000,
    "title": 1_000,
    "caption": 2_000,
    "series": 100,
    "annotations": 100,
    "ohlc": 5_000,
    "heatmapDimension": 200,
    "heatmapCells": 20_000,
    "metrics": 50,
    "embedHeightMin": 200,
    "embedHeightMax": 1_200,
    "codeLanguage": 40,
    "searchText": 1_000,
}

BLOCK_TYPES = (
    "section",
    "heading",
    "paragraph",
    "list",
    "table",
    "chart",
    "embed",
    "timestamp",
    "quote",
    "callout",
    "code",
    "divider",
    "image",
    "toggle",
    "metrics",
    "toc",
    "pageBreak",
)
OPERATION_TYPES = (
    "insertBlock",
    "updateBlock",
    "moveBlock",
    "deleteBlock",
    "setTitle",
    "setFormat",
    "addCitation",
    "insertBlocks",
    "duplicateBlock",
    "replaceText",
    "deleteBlocks",
    "moveBlocks",
    "updateCitation",
    "removeCitation",
)
CONTAINER_TYPES = ("section", "toggle")
HIGHLIGHTS = ("yellow", "green", "blue", "pink", "gray")
CALLOUT_TONES = ("info", "success", "warning", "danger", "note")
IMAGE_WIDTHS = ("narrow", "normal", "wide", "full")
LIST_STYLES = ("bullet", "number", "todo")
TABLE_ALIGNMENTS = ("left", "center", "right")
METRIC_TONES = ("up", "down", "neutral")
AXIS_FORMATS = ("number", "percent", "currency", "compact")
KNOWN_KINDS = (
    "pie",
    "donut",
    "bar",
    "trend",
    "line",
    "area",
    "scatter",
    "histogram",
    "candlestick",
    "heatmap",
    "waterfall",
)
CATEGORY_KINDS = ("bar", "trend", "line", "area", "histogram", "candlestick", "waterfall")

MAX_SAFE = 9_007_199_254_740_991
MAX_FLOAT = 1.7976931348623157e308


class Invalid(Exception):
    def __init__(self, issue: dict[str, Any]) -> None:
        super().__init__(issue["message"])
        self.issue = issue


def _fail(message: str, path: str, hint: str | None = None) -> NoReturn:
    issue: dict[str, Any] = {"code": "validation", "message": message, "path": path}
    if hint:
        issue["hint"] = hint
    raise Invalid(issue)


def js_length(text: str) -> int:
    """String length as JavaScript counts it: UTF-16 code units."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _js_key_order(keys: list[str]) -> list[str]:
    """Own-property order of a JavaScript object: array-index keys ascending, then the rest in insertion order."""
    index = [k for k in keys if re.fullmatch(r"0|[1-9][0-9]{0,9}", k) and int(k) < 2**32 - 1]
    index.sort(key=int)
    seen = set(index)
    return index + [k for k in keys if k not in seen]


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _object(value: Any, path: str, required: list[str], optional: list[str] | None = None) -> dict[str, Any]:
    optional = optional or []
    if not isinstance(value, dict):
        hint = None
        if required:
            more = f" (optional: {', '.join(optional)})" if optional else ""
            hint = f"Provide an object with: {', '.join(required)}{more}."
        _fail("Expected a plain object.", path, hint)
    allowed = [*required, *optional]
    for key in _js_key_order(list(value)):
        if key not in allowed:
            _fail("Unknown property.", f"{path}.{key}", f"Remove it. Allowed properties here: {', '.join(allowed)}.")
    for key in required:
        if key not in value:
            _fail("Required property is missing.", f"{path}.{key}", f'Add "{key}".')
    return value


def _string(value: Any, path: str, maximum: int | float = LIMITS["text"], allow_empty: bool = True) -> str:
    if not isinstance(value, str) or js_length(value) > maximum or (not allow_empty and len(value) == 0):
        _fail(f"Expected {'a' if allow_empty else 'a nonempty'} string of at most {_num(maximum)} characters.", path)
    return value


def _num(value: int | float) -> str:
    return str(int(value)) if float(value).is_integer() else repr(value)


_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]*")


def _id(value: Any, path: str) -> str:
    result = _string(value, path, 128, False)
    if not _ID.fullmatch(result):
        _fail(
            "ID must use ASCII letters, numbers, dots, underscores, colons or hyphens.",
            path,
            'Start with a letter or digit, for example "sec-1" or "macro.summary".',
        )
    return result


def _integer(value: Any, path: str, minimum: int = 0, maximum: int = MAX_SAFE) -> int:
    ok = False
    if _is_number(value):
        ok = math.isfinite(value) and value == math.floor(value) if isinstance(value, float) else True
        if ok:
            ok = abs(value) <= MAX_SAFE and minimum <= value <= maximum
    if not ok:
        _fail(f"Expected an integer between {minimum} and {maximum}.", path)
    return int(value)


def _as_float(value: Any) -> float:
    try:
        return float(value)
    except OverflowError:
        return math.inf


def _finite(value: Any, path: str, minimum: float = -MAX_FLOAT, maximum: float = MAX_FLOAT) -> float | int:
    if not _is_number(value):
        _fail("Expected a finite number in the supported range.", path)
    number = _as_float(value)
    if not math.isfinite(number) or number < minimum or number > maximum:
        _fail("Expected a finite number in the supported range.", path)
    return value  # type: ignore[no-any-return]


def _boolean(value: Any, path: str) -> bool:
    if not isinstance(value, bool):
        _fail("Expected a boolean.", path)
    return value


def _enumeration(value: Any, path: str, values: tuple[str, ...] | list[str]) -> str:
    if not isinstance(value, str) or value not in values:
        _fail(f"Expected one of: {', '.join(values)}.", path)
    return value


def _array(value: Any, path: str, maximum: int, parse: Any) -> list[Any]:
    if not isinstance(value, list) or len(value) > maximum:
        _fail(f"Expected an array with at most {maximum} entries.", path)
    return [parse(entry, f"{path}[{index}]") for index, entry in enumerate(value)]


def _unique(values: list[str], path: str, hint: str | None = None) -> None:
    if len(set(values)) != len(values):
        _fail("IDs must be unique.", path, hint)


# --- URLs ---------------------------------------------------------------------------------------------------------

_JS_SPACE = frozenset("\t\n\x0b\x0c\r                  　﻿")
_FORBIDDEN_HOST = frozenset("\x00\t\n\r #/:<>?@[\\]^|%")
_PATH_SET = frozenset(' "#<>?`{}')
_QUERY_SET = frozenset(" \"#<>'")
_FRAGMENT_SET = frozenset(' "<>`')
_SCHEME = re.compile(r"([A-Za-z][A-Za-z0-9+.\-]*):")
_DEFAULT_PORT = {"http": 80, "https": 443}


def _encode(text: str, special: frozenset[str]) -> str:
    out: list[str] = []
    for ch in text:
        code = ord(ch)
        if code <= 0x20 or code >= 0x7F or ch in special:
            out.extend(f"%{byte:02X}" for byte in ch.encode("utf-8", "surrogatepass"))
        else:
            out.append(ch)
    return "".join(out)


def _percent_decode(text: str) -> bytes | None:
    out = bytearray()
    i, raw = 0, text.encode("utf-8")
    while i < len(raw):
        if raw[i] == 0x25 and i + 2 < len(raw) + 0 and re.fullmatch(rb"[0-9A-Fa-f]{2}", raw[i + 1 : i + 3]):
            out.append(int(raw[i + 1 : i + 3], 16))
            i += 3
        else:
            out.append(raw[i])
            i += 1
    return bytes(out)


def _parse_host(host: str) -> str | None:
    if host.startswith("["):
        return None
    decoded = _percent_decode(host)
    try:
        text = (decoded or b"").decode("utf-8")
    except UnicodeDecodeError:
        return None
    if not text or not text.isascii():
        return None
    text = text.lower()
    if any(ch in _FORBIDDEN_HOST or ord(ch) <= 0x1F or ord(ch) == 0x7F for ch in text):
        return None
    labels = text.split(".")
    if any(label.startswith("xn--") for label in labels):
        return None
    checked = labels[:-1] if len(labels) > 1 and labels[-1] == "" else labels
    last = checked[-1]
    if re.fullmatch(r"[0-9]+", last) or re.fullmatch(r"0x[0-9a-f]*", last):
        canonical = len(labels) == 4 and all(re.fullmatch(r"0|[1-9][0-9]{0,2}", p) and int(p) <= 255 for p in labels)
        return text if canonical else None
    return text


def _normalize_path(path: str) -> str:
    if not path:
        return "/"
    segments = path.split("/")[1:]
    out: list[str] = []
    for index, segment in enumerate(segments):
        last = index == len(segments) - 1
        encoded = _encode(segment, _PATH_SET)
        lowered = encoded.lower()
        if lowered in ("..", ".%2e", "%2e.", "%2e%2e"):
            if out:
                out.pop()
            if last:
                out.append("")
        elif lowered in (".", "%2e"):
            if last:
                out.append("")
        else:
            out.append(encoded)
    return "/" + "/".join(out)


def _parse_url(value: str) -> tuple[str, str] | None:
    match = _SCHEME.match(value)
    if not match:
        return None
    scheme = match.group(1).lower()
    if scheme not in _DEFAULT_PORT:
        return None
    rest = value[match.end() :].lstrip("/")
    fragment: str | None = None
    query: str | None = None
    if "#" in rest:
        rest, fragment = rest.split("#", 1)
    if "?" in rest:
        rest, query = rest.split("?", 1)
    slash = rest.find("/")
    authority, path = (rest, "") if slash < 0 else (rest[:slash], rest[slash:])
    if "@" in authority:
        credentials, authority = authority.rsplit("@", 1)
        if credentials not in ("", ":"):
            return None
    port: int | None = None
    if ":" in authority:
        authority, _, port_text = authority.rpartition(":")
        if port_text:
            if not re.fullmatch(r"[0-9]+", port_text) or int(port_text) > 65535:
                return None
            port = int(port_text)
    host = _parse_host(authority)
    if host is None:
        return None
    href = f"{scheme}://{host}"
    if port is not None and port != _DEFAULT_PORT[scheme]:
        href += f":{port}"
    href += _normalize_path(path)
    if query is not None:
        href += "?" + _encode(query, _QUERY_SET)
    if fragment is not None:
        href += "#" + _encode(fragment, _FRAGMENT_SET)
    return scheme, href


def safe_url(value: Any, https_only: bool = False) -> str | None:
    """The normalized URL, or None when it is not an absolute HTTP(S) URL without credentials."""
    if not isinstance(value, str) or js_length(value) > 4096:
        return None
    if any(ch in _JS_SPACE or ch == "\\" or ord(ch) <= 0x1F or ord(ch) == 0x7F for ch in value):
        return None
    parsed = _parse_url(value)
    if parsed is None:
        return None
    scheme, href = parsed
    if https_only and scheme != "https":
        return None
    return href


def _url(value: Any, path: str, https_only: bool = False) -> str:
    result = safe_url(value, https_only)
    if not result:
        _fail(
            f"Expected an absolute {'HTTPS' if https_only else 'HTTP or HTTPS'} URL without credentials.",
            path,
            f"Use a full {'https://' if https_only else 'http(s)://'} URL such as https://example.com/page, "
            "with no spaces and no user:password.",
        )
    return result


# --- timestamps and actors ----------------------------------------------------------------------------------------

_TIMESTAMP = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?Z")


def _days_in_month(year: int, month: int) -> int:
    if month == 2:
        return 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28
    return 30 if month in (4, 6, 9, 11) else 31


def timestamp(value: Any, path: str = "timestamp") -> str:
    """UTC ISO timestamps only; calendar rollover (such as February 30) is rejected."""
    result = _string(value, path, 30, False)
    match = _TIMESTAMP.fullmatch(result)
    if not match:
        _fail("Expected an ISO UTC timestamp.", path, "Use a form like 2026-10-05T12:00:00Z (UTC, trailing Z).")
    year, month, day, hour, minute, second = (int(match.group(i)) for i in range(1, 7))
    if not (
        1 <= month <= 12 and 1 <= day <= _days_in_month(year, month) and hour <= 23 and minute <= 59 and second <= 59
    ):
        _fail("Timestamp contains an invalid calendar date or time.", path)
    return result


def timestamp_millis(text: str) -> int:
    """Milliseconds since the epoch of a validated timestamp (proleptic Gregorian, UTC)."""
    match = _TIMESTAMP.fullmatch(text)
    assert match is not None
    year, month, day, hour, minute, second = (int(match.group(i)) for i in range(1, 7))
    millis = int((match.group(7) or "").ljust(3, "0"))
    y = year - (1 if month <= 2 else 0)
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    days = era * 146097 + doe - 719468
    return ((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis


def _parent(value: Any, path: str) -> str | None:
    return None if value is None else _id(value, path)


def read_actor(value: Any, path: str = "actor") -> dict[str, str]:
    v = _object(value, path, ["id", "kind"])
    return {
        "id": _id(v["id"], f"{path}.id"),
        "kind": _enumeration(v["kind"], f"{path}.kind", ["human", "agent", "system"]),
    }


# --- charts -------------------------------------------------------------------------------------------------------

_COLOR = re.compile(r"#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[A-Za-z]{3,30}|var\(--[A-Za-z0-9_-]{1,60}\)")
_CURRENCY = re.compile(r"[A-Z]{3}")


def _color(value: Any, path: str) -> str:
    result = _string(value, path, 64, False)
    if not _COLOR.fullmatch(result):
        _fail(
            "Expected a hex color (#rgb, #rrggbb), a CSS color keyword or var(--token).",
            path,
            'Use for example "#2f6fed" or "var(--se-series-1)". Functions such as url() are not accepted.',
        )
    return result


def _magnitude(value: Any, path: str) -> float | int:
    return _finite(value, path, -LIMITS["chartMagnitude"], LIMITS["chartMagnitude"])


def _chart(value: Any, path: str) -> dict[str, Any]:  # noqa: C901, PLR0912, PLR0915
    v = _object(
        value,
        path,
        ["kind", "title", "labels", "series"],
        [
            "unit",
            "asOf",
            "stacked",
            "horizontal",
            "yAxis",
            "xLabel",
            "caption",
            "source",
            "annotations",
            "points",
            "ohlc",
            "matrix",
        ],
    )
    text_length = 0

    def parse_label(entry: Any, p: str) -> str:
        nonlocal text_length
        label = _string(entry, p, 1_000)
        text_length += js_length(label)
        if text_length > LIMITS["json"]:
            _fail("Chart labels exceed the supported text size.", path)
        return label

    labels = _array(v["labels"], f"{path}.labels", int(LIMITS["chartPoints"]), parse_label)
    if not labels:
        _fail(
            "A chart requires at least one label.",
            f"{path}.labels",
            "Every kind needs labels and series; scatter, candlestick and heatmap also carry a labels/series "
            "fallback table next to points, ohlc or matrix.",
        )

    def parse_series(entry: Any, p: str) -> dict[str, Any]:
        item = _object(entry, p, ["name", "values"], ["color"])
        values = _array(item["values"], f"{p}.values", int(LIMITS["chartPoints"]), _magnitude)
        if len(values) != len(labels):
            _fail(
                "Series length must match chart labels.",
                f"{p}.values",
                f"Provide exactly {len(labels)} values, one per label.",
            )
        out: dict[str, Any] = {"name": _string(item["name"], f"{p}.name", 1_000), "values": values}
        if "color" in item:
            out["color"] = _color(item["color"], f"{p}.color")
        return out

    series = _array(v["series"], f"{path}.series", int(LIMITS["series"]), parse_series)
    if not series or len(labels) * len(series) > LIMITS["chartPoints"]:
        _fail("Chart must contain 1 to 20,000 numeric points.", path)
    kind = _id(v["kind"], f"{path}.kind")
    known = kind in KNOWN_KINDS
    if kind in ("pie", "donut"):
        first = series[0]["values"]
        total = 0.0
        for item in first:
            total += item
        if (
            len(series) != 1
            or any(item < 0 for item in first)
            or not any(item > 0 for item in first)
            or not math.isfinite(total)
        ):
            _fail(
                f"{'Pie' if kind == 'pie' else 'Donut'} charts require one nonnegative series "
                "with a finite positive total.",
                path,
                "Use a single series of nonnegative values, or switch to a bar chart.",
            )
    if kind == "histogram" and (len(series) != 1 or any(item < 0 for item in series[0]["values"])):
        _fail(
            "Histogram charts require one series of nonnegative counts.",
            path,
            "Put bin labels in labels and one count per bin in a single series.",
        )
    if kind == "waterfall" and len(series) != 1:
        _fail(
            "Waterfall charts require exactly one series of signed deltas.",
            path,
            "Put step names in labels and one signed change per step in a single series.",
        )

    def parse_point(entry: Any, p: str) -> dict[str, Any]:
        point = _object(entry, p, ["series", "x", "y"])
        return {
            "series": _string(point["series"], f"{p}.series", 1_000),
            "x": _magnitude(point["x"], f"{p}.x"),
            "y": _magnitude(point["y"], f"{p}.y"),
        }

    points = _array(v["points"], f"{path}.points", int(LIMITS["chartPoints"]), parse_point) if "points" in v else None

    def parse_candle(entry: Any, p: str) -> dict[str, Any]:
        candle = _object(entry, p, ["t", "o", "h", "l", "c"], ["v"])
        o, h = _magnitude(candle["o"], f"{p}.o"), _magnitude(candle["h"], f"{p}.h")
        low, c = _magnitude(candle["l"], f"{p}.l"), _magnitude(candle["c"], f"{p}.c")
        if low > min(o, c) or h < max(o, c):
            _fail(
                "A candle needs low <= open/close <= high.",
                p,
                "Check the o/h/l/c order of this candle; h must be the highest and l the lowest price.",
            )
        out: dict[str, Any] = {"t": _string(candle["t"], f"{p}.t", 1_000, False), "o": o, "h": h, "l": low, "c": c}
        if "v" in candle:
            out["v"] = _finite(candle["v"], f"{p}.v", 0, LIMITS["chartMagnitude"])
        return out

    ohlc = _array(v["ohlc"], f"{path}.ohlc", int(LIMITS["ohlc"]), parse_candle) if "ohlc" in v else None
    matrix: dict[str, Any] | None = None
    if "matrix" in v:
        m = _object(v["matrix"], f"{path}.matrix", ["rows", "columns", "values"])
        dim = int(LIMITS["heatmapDimension"])
        rows = _array(m["rows"], f"{path}.matrix.rows", dim, lambda e, p: _string(e, p, 1_000))
        columns = _array(m["columns"], f"{path}.matrix.columns", dim, lambda e, p: _string(e, p, 1_000))
        if not rows or not columns or len(rows) * len(columns) > LIMITS["heatmapCells"]:
            _fail(
                f"A heatmap needs at least one row and column and at most {LIMITS['heatmapCells']} cells.",
                f"{path}.matrix",
            )
        cells = _array(
            m["values"], f"{path}.matrix.values", len(rows), lambda row, rp: _array(row, rp, len(columns), _magnitude)
        )
        if len(cells) != len(rows) or any(len(row) != len(columns) for row in cells):
            _fail(
                "Heatmap values must have one row per rows entry and one cell per column.",
                f"{path}.matrix.values",
                f"Provide {len(rows)} rows of {len(columns)} numbers.",
            )
        matrix = {"rows": rows, "columns": columns, "values": cells}
    if known:
        if points is not None and kind != "scatter":
            _fail(
                "points are only valid for scatter charts.", f"{path}.points", 'Remove points or set kind to "scatter".'
            )
        if ohlc is not None and kind != "candlestick":
            _fail(
                "ohlc is only valid for candlestick charts.",
                f"{path}.ohlc",
                'Remove ohlc or set kind to "candlestick".',
            )
        if matrix is not None and kind != "heatmap":
            _fail(
                "matrix is only valid for heatmap charts.", f"{path}.matrix", 'Remove matrix or set kind to "heatmap".'
            )
    if kind == "scatter" and not points:
        _fail(
            "Scatter charts require points.",
            f"{path}.points",
            "Provide points: [{series, x, y}, ...] next to the labels/series fallback table.",
        )
    if kind == "candlestick" and not ohlc:
        _fail(
            "Candlestick charts require ohlc candles.",
            f"{path}.ohlc",
            "Provide ohlc: [{t, o, h, l, c, v?}, ...] next to the labels/series close-price fallback.",
        )
    if kind == "heatmap" and matrix is None:
        _fail(
            "Heatmap charts require a matrix.",
            f"{path}.matrix",
            "Provide matrix: {rows, columns, values} next to the labels/series fallback table.",
        )
    y_axis: dict[str, Any] | None = None
    if "yAxis" in v:
        axis = _object(v["yAxis"], f"{path}.yAxis", [], ["label", "format", "min", "max", "currency"])
        low_y = _magnitude(axis["min"], f"{path}.yAxis.min") if "min" in axis else None
        high_y = _magnitude(axis["max"], f"{path}.yAxis.max") if "max" in axis else None
        if low_y is not None and high_y is not None and low_y >= high_y:
            _fail("yAxis.min must be less than yAxis.max.", f"{path}.yAxis")
        currency = _string(axis["currency"], f"{path}.yAxis.currency", 3, False) if "currency" in axis else None
        if currency is not None and not _CURRENCY.fullmatch(currency):
            _fail("Expected a three-letter ISO 4217 currency code.", f"{path}.yAxis.currency", 'Use for example "USD".')
        y_axis = {}
        if "label" in axis:
            y_axis["label"] = _string(axis["label"], f"{path}.yAxis.label", LIMITS["title"])
        if "format" in axis:
            y_axis["format"] = _enumeration(axis["format"], f"{path}.yAxis.format", AXIS_FORMATS)
        if low_y is not None:
            y_axis["min"] = low_y
        if high_y is not None:
            y_axis["max"] = high_y
        if currency is not None:
            y_axis["currency"] = currency
    annotations: list[Any] | None = None
    if "annotations" in v:

        def parse_note(entry: Any, p: str) -> dict[str, Any]:
            note = _object(entry, p, ["label", "at"], ["value"])
            at = _string(note["at"], f"{p}.at", 1_000, False)
            if kind in CATEGORY_KINDS and at not in labels:
                _fail(
                    'Annotation "at" must be one of the chart labels.',
                    f"{p}.at",
                    f"Use one of: {', '.join(labels[:8])}{', ...' if len(labels) > 8 else ''}.",
                )
            out: dict[str, Any] = {"label": _string(note["label"], f"{p}.label", 1_000, False), "at": at}
            if "value" in note:
                out["value"] = _magnitude(note["value"], f"{p}.value")
            return out

        annotations = _array(v["annotations"], f"{path}.annotations", int(LIMITS["annotations"]), parse_note)
    result: dict[str, Any] = {
        "kind": kind,
        "title": _string(v["title"], f"{path}.title", 1_000),
        "labels": labels,
        "series": series,
    }
    if "unit" in v:
        result["unit"] = _string(v["unit"], f"{path}.unit", 100)
    if "asOf" in v:
        result["asOf"] = timestamp(v["asOf"], f"{path}.asOf")
    if "stacked" in v:
        result["stacked"] = _boolean(v["stacked"], f"{path}.stacked")
    if "horizontal" in v:
        result["horizontal"] = _boolean(v["horizontal"], f"{path}.horizontal")
    if y_axis is not None:
        result["yAxis"] = y_axis
    if "xLabel" in v:
        result["xLabel"] = _string(v["xLabel"], f"{path}.xLabel", LIMITS["title"])
    if "caption" in v:
        result["caption"] = _string(v["caption"], f"{path}.caption", LIMITS["caption"])
    if "source" in v:
        result["source"] = _string(v["source"], f"{path}.source", LIMITS["title"])
    if annotations is not None:
        result["annotations"] = annotations
    if points is not None:
        result["points"] = points
    if ohlc is not None:
        result["ohlc"] = ohlc
    if matrix is not None:
        result["matrix"] = matrix
    return result


# --- blocks -------------------------------------------------------------------------------------------------------

_RUN_FLAGS = ("bold", "italic", "code", "strike", "underline")


def _runs(value: Any, path: str) -> list[dict[str, Any]]:
    def parse_run(entry: Any, p: str) -> dict[str, Any]:
        run = _object(
            entry, p, ["text"], ["bold", "italic", "code", "href", "strike", "underline", "highlight", "citationId"]
        )
        out: dict[str, Any] = {"text": _string(run["text"], f"{p}.text")}
        for flag in ("bold", "italic", "code"):
            if flag in run:
                out[flag] = _boolean(run[flag], f"{p}.{flag}")
        if "href" in run:
            out["href"] = _url(run["href"], f"{p}.href")
        for flag in ("strike", "underline"):
            if flag in run:
                out[flag] = _boolean(run[flag], f"{p}.{flag}")
        if "highlight" in run:
            out["highlight"] = _enumeration(run["highlight"], f"{p}.highlight", HIGHLIGHTS)
        if "citationId" in run:
            out["citationId"] = _id(run["citationId"], f"{p}.citationId")
        return out

    parsed = _array(value, path, int(LIMITS["runs"]), parse_run)
    if sum(js_length(run["text"]) for run in parsed) > LIMITS["text"]:
        _fail("Text exceeds the supported size.", path)
    return parsed


def _types_hint() -> str:
    return f"Use one of: {', '.join(BLOCK_TYPES)}."


def _content(value: Any, path: str) -> dict[str, Any]:  # noqa: C901, PLR0912, PLR0915
    if not isinstance(value, dict):
        _fail(
            "Expected block content.",
            path,
            'Provide an object such as {"type":"paragraph","runs":[{"text":"..."}]}. '
            f"Block types: {', '.join(BLOCK_TYPES)}.",
        )
    if "type" not in value:
        _fail("Block content type is required.", f"{path}.type", _types_hint())
    kind = value["type"]
    if kind == "section":
        v = _object(value, path, ["type", "title"])
        return {"type": "section", "title": _string(v["title"], f"{path}.title", LIMITS["title"])}
    if kind == "heading":
        v = _object(value, path, ["type", "level", "text"])
        return {
            "type": "heading",
            "level": _integer(v["level"], f"{path}.level", 1, 3),
            "text": _string(v["text"], f"{path}.text"),
        }
    if kind == "paragraph":
        v = _object(value, path, ["type", "runs"])
        return {"type": "paragraph", "runs": _runs(v["runs"], f"{path}.runs")}
    if kind == "list":
        v = _object(value, path, ["type", "ordered", "items"], ["style", "checked", "indent"])
        text_length = 0
        ordered = _boolean(v["ordered"], f"{path}.ordered")

        def parse_item(entry: Any, p: str) -> str:
            nonlocal text_length
            item = _string(entry, p, LIMITS["listItemText"])
            text_length += js_length(item)
            if text_length > LIMITS["json"]:
                _fail("List exceeds the supported text size.", path)
            return item

        items = _array(v["items"], f"{path}.items", int(LIMITS["listItems"]), parse_item)
        style = _enumeration(v["style"], f"{path}.style", LIST_STYLES) if "style" in v else None
        if style == "number" and not ordered:
            _fail(
                'A "number" list must set ordered: true.',
                f"{path}.ordered",
                'Set ordered: true, or use style "bullet".',
            )
        if style in ("bullet", "todo") and ordered:
            _fail(
                f'A "{style}" list must set ordered: false.',
                f"{path}.ordered",
                'Set ordered: false, or use style "number".',
            )
        checked = (
            _array(v["checked"], f"{path}.checked", int(LIMITS["listItems"]), _boolean) if "checked" in v else None
        )
        if checked is not None and style != "todo":
            _fail(
                'checked is only valid on a "todo" list.',
                f"{path}.checked",
                'Set style: "todo" (with ordered: false) or remove checked.',
            )
        if checked is not None and len(checked) != len(items):
            _fail("checked must have one entry per list item.", f"{path}.checked", f"Provide {len(items)} booleans.")
        indent = (
            _array(
                v["indent"],
                f"{path}.indent",
                int(LIMITS["listItems"]),
                lambda e, p: _integer(e, p, 0, int(LIMITS["listIndent"])),
            )
            if "indent" in v
            else None
        )
        if indent is not None and len(indent) != len(items):
            _fail(
                "indent must have one entry per list item.",
                f"{path}.indent",
                f"Provide {len(items)} integers from 0 to {LIMITS['listIndent']}.",
            )
        out: dict[str, Any] = {"type": "list", "ordered": ordered, "items": items}
        if style:
            out["style"] = style
        if checked is not None:
            out["checked"] = checked
        if indent is not None:
            out["indent"] = indent
        return out
    if kind == "table":
        v = _object(value, path, ["type", "columns", "rows"], ["align", "caption", "headerColumn"])
        columns = _array(
            v["columns"], f"{path}.columns", int(LIMITS["tableColumns"]), lambda e, p: _string(e, p, LIMITS["title"])
        )
        if not columns:
            _fail("Table requires at least one column.", f"{path}.columns")
        text_len = sum(js_length(c) for c in columns)

        def parse_row(entry: Any, p: str) -> list[str]:
            nonlocal text_len

            def parse_cell(cell: Any, cp: str) -> str:
                nonlocal text_len
                item = _string(cell, cp, LIMITS["tableCellText"])
                text_len += js_length(item)
                if text_len > LIMITS["json"]:
                    _fail("Table exceeds the supported text size.", path)
                return item

            row = _array(entry, p, len(columns), parse_cell)
            if len(row) != len(columns):
                _fail("Table row width must match its columns.", p, f"Each row needs exactly {len(columns)} cells.")
            return row

        max_rows = min(int(LIMITS["tableRows"]), int(LIMITS["tableCells"]) // len(columns))
        rows = _array(v["rows"], f"{path}.rows", max_rows, parse_row)
        if len(columns) * len(rows) > LIMITS["tableCells"]:
            _fail(f"Table exceeds {LIMITS['tableCells']} cells.", path)
        align = (
            _array(
                v["align"],
                f"{path}.align",
                int(LIMITS["tableColumns"]),
                lambda e, p: _enumeration(e, p, TABLE_ALIGNMENTS),
            )
            if "align" in v
            else None
        )
        if align is not None and len(align) != len(columns):
            _fail(
                "align must have one entry per column.",
                f"{path}.align",
                f"Provide {len(columns)} entries of left, center or right.",
            )
        out = {"type": "table", "columns": columns, "rows": rows}
        if align is not None:
            out["align"] = align
        if "caption" in v:
            out["caption"] = _string(v["caption"], f"{path}.caption", LIMITS["caption"])
        if "headerColumn" in v:
            out["headerColumn"] = _boolean(v["headerColumn"], f"{path}.headerColumn")
        return out
    if kind == "chart":
        v = _object(value, path, ["type", "spec"])
        return {"type": "chart", "spec": _chart(v["spec"], f"{path}.spec")}
    if kind == "embed":
        v = _object(value, path, ["type", "provider", "url", "title"], ["height"])
        out = {
            "type": "embed",
            "provider": _enumeration(v["provider"], f"{path}.provider", ["superchart"]),
            "url": _url(v["url"], f"{path}.url", True),
            "title": _string(v["title"], f"{path}.title", LIMITS["title"]),
        }
        if "height" in v:
            out["height"] = _integer(
                v["height"], f"{path}.height", int(LIMITS["embedHeightMin"]), int(LIMITS["embedHeightMax"])
            )
        return out
    if kind == "timestamp":
        v = _object(value, path, ["type", "at", "label"])
        return {
            "type": "timestamp",
            "at": timestamp(v["at"], f"{path}.at"),
            "label": _string(v["label"], f"{path}.label", LIMITS["title"]),
        }
    if kind == "quote":
        v = _object(value, path, ["type", "runs"], ["attribution"])
        out = {"type": "quote", "runs": _runs(v["runs"], f"{path}.runs")}
        if "attribution" in v:
            out["attribution"] = _string(v["attribution"], f"{path}.attribution", LIMITS["title"])
        return out
    if kind == "callout":
        v = _object(value, path, ["type", "tone", "runs"], ["title"])
        out = {"type": "callout", "tone": _enumeration(v["tone"], f"{path}.tone", CALLOUT_TONES)}
        if "title" in v:
            out["title"] = _string(v["title"], f"{path}.title", LIMITS["title"])
        out["runs"] = _runs(v["runs"], f"{path}.runs")
        return out
    if kind == "code":
        v = _object(value, path, ["type", "language", "text"])
        language = _string(v["language"], f"{path}.language", LIMITS["codeLanguage"])
        if not re.fullmatch(r"[A-Za-z0-9+#._-]*", language):
            _fail(
                "Language must use letters, digits and + # . _ - only.",
                f"{path}.language",
                'Use a short name such as "ts", "python" or "sql", or "" for plain text.',
            )
        return {"type": "code", "language": language, "text": _string(v["text"], f"{path}.text")}
    if kind in ("divider", "toc", "pageBreak"):
        _object(value, path, ["type"])
        return {"type": kind}
    if kind == "image":
        v = _object(value, path, ["type", "url", "alt"], ["caption", "width"])
        out = {
            "type": "image",
            "url": _url(v["url"], f"{path}.url", True),
            "alt": _string(v["alt"], f"{path}.alt", LIMITS["title"]),
        }
        if "caption" in v:
            out["caption"] = _string(v["caption"], f"{path}.caption", LIMITS["caption"])
        if "width" in v:
            out["width"] = _enumeration(v["width"], f"{path}.width", IMAGE_WIDTHS)
        return out
    if kind == "toggle":
        v = _object(value, path, ["type", "title", "open"])
        return {
            "type": "toggle",
            "title": _string(v["title"], f"{path}.title", LIMITS["title"]),
            "open": _boolean(v["open"], f"{path}.open"),
        }
    if kind == "metrics":
        v = _object(value, path, ["type", "items"])

        def parse_metric(entry: Any, p: str) -> dict[str, Any]:
            item = _object(entry, p, ["label", "value"], ["change", "tone", "hint"])
            out2: dict[str, Any] = {
                "label": _string(item["label"], f"{p}.label", LIMITS["title"]),
                "value": _string(item["value"], f"{p}.value", LIMITS["title"]),
            }
            if "change" in item:
                out2["change"] = _magnitude(item["change"], f"{p}.change")
            if "tone" in item:
                out2["tone"] = _enumeration(item["tone"], f"{p}.tone", METRIC_TONES)
            if "hint" in item:
                out2["hint"] = _string(item["hint"], f"{p}.hint", LIMITS["title"])
            return out2

        items2 = _array(v["items"], f"{path}.items", int(LIMITS["metrics"]), parse_metric)
        if not items2:
            _fail(
                "A metrics block requires at least one item.",
                f"{path}.items",
                "Provide items: [{label, value, change?, tone?, hint?}, ...].",
            )
        return {"type": "metrics", "items": items2}
    return _fail("Unsupported block content type. Raw HTML is not supported.", f"{path}.type", _types_hint())


def _block_input(value: Any, path: str, persisted: bool = False) -> dict[str, Any]:
    extra = ["version", "createdAt", "updatedAt"] if persisted else []
    v = _object(value, path, ["id", "parentId", "content", "citationIds", *extra])
    citation_ids = _array(v["citationIds"], f"{path}.citationIds", int(LIMITS["citations"]), _id)
    _unique(citation_ids, f"{path}.citationIds")
    result: dict[str, Any] = {
        "id": _id(v["id"], f"{path}.id"),
        "parentId": _parent(v["parentId"], f"{path}.parentId"),
        "content": _content(v["content"], f"{path}.content"),
        "citationIds": citation_ids,
    }
    if persisted:
        result["version"] = _integer(v["version"], f"{path}.version", 1)
        result["createdAt"] = timestamp(v["createdAt"], f"{path}.createdAt")
        result["updatedAt"] = timestamp(v["updatedAt"], f"{path}.updatedAt")
    return result


def _citation(value: Any, path: str) -> dict[str, Any]:
    v = _object(value, path, ["id", "title", "url", "accessedAt"], ["publishedAt"])
    out: dict[str, Any] = {
        "id": _id(v["id"], f"{path}.id"),
        "title": _string(v["title"], f"{path}.title", 1_000),
        "url": _url(v["url"], f"{path}.url"),
        "accessedAt": timestamp(v["accessedAt"], f"{path}.accessedAt"),
    }
    if "publishedAt" in v:
        out["publishedAt"] = timestamp(v["publishedAt"], f"{path}.publishedAt")
    return out


def _format(value: Any, path: str) -> dict[str, Any]:
    v = _object(value, path, ["page", "font", "fontSize", "lineHeight"])
    return {
        "page": _enumeration(v["page"], f"{path}.page", ["screen", "A4", "letter"]),
        "font": _enumeration(v["font"], f"{path}.font", ["sans", "serif", "mono"]),
        "fontSize": _finite(v["fontSize"], f"{path}.fontSize", 8, 72),
        "lineHeight": _finite(v["lineHeight"], f"{path}.lineHeight", 1, 3),
    }


def _block_refs(value: Any, path: str) -> list[dict[str, Any]]:
    def parse_ref(entry: Any, p: str) -> dict[str, Any]:
        ref = _object(entry, p, ["blockId", "expectedVersion"])
        return {
            "blockId": _id(ref["blockId"], f"{p}.blockId"),
            "expectedVersion": _integer(ref["expectedVersion"], f"{p}.expectedVersion", 1),
        }

    refs = _array(value, path, int(LIMITS["blocksPerOperation"]), parse_ref)
    if not refs:
        _fail("At least one block is required.", path)
    _unique([r["blockId"] for r in refs], path, "List each block once.")
    return refs


def _id_map(value: Any, path: str) -> dict[str, str]:
    if not isinstance(value, dict):
        _fail(
            "Expected an object mapping old block IDs to new block IDs.",
            path,
            'Example: {"intro":"intro-copy"}. Include the block and every descendant.',
        )
    keys = _js_key_order(list(value))
    if not keys or len(keys) > LIMITS["blocksPerOperation"]:
        _fail(f"Expected between 1 and {LIMITS['blocksPerOperation']} ID mappings.", path)
    result: dict[str, str] = {}
    for key in keys:
        result[_id(key, f"{path}.{key}")] = _id(value[key], f"{path}.{key}")
    _unique(list(result.values()), path, "Every new ID must be different.")
    return result


def _operation(value: Any, path: str) -> dict[str, Any]:  # noqa: C901, PLR0912, PLR0915
    if not isinstance(value, dict):
        _fail(
            "Expected an operation.",
            path,
            'Provide an object such as {"type":"setTitle","title":"..."}. '
            f"Operation types: {', '.join(OPERATION_TYPES)}.",
        )
    if "type" not in value:
        _fail("Operation type is required.", f"{path}.type", f"Use one of: {', '.join(OPERATION_TYPES)}.")
    kind = value["type"]

    def after(v: dict[str, Any]) -> dict[str, Any]:
        return {"afterId": _parent(v["afterId"], f"{path}.afterId")} if "afterId" in v else {}

    def guard(v: dict[str, Any]) -> tuple[str, int]:
        return _id(v["blockId"], f"{path}.blockId"), _integer(v["expectedVersion"], f"{path}.expectedVersion", 1)

    if kind == "insertBlock":
        v = _object(value, path, ["type", "block"], ["afterId"])
        return {"type": "insertBlock", "block": _block_input(v["block"], f"{path}.block"), **after(v)}
    if kind == "updateBlock":
        v = _object(value, path, ["type", "blockId", "expectedVersion", "content"], ["citationIds"])
        citation_ids = (
            _array(v["citationIds"], f"{path}.citationIds", int(LIMITS["citations"]), _id)
            if "citationIds" in v
            else None
        )
        if citation_ids is not None:
            _unique(citation_ids, f"{path}.citationIds")
        block_id, version = guard(v)
        out: dict[str, Any] = {
            "type": "updateBlock",
            "blockId": block_id,
            "expectedVersion": version,
            "content": _content(v["content"], f"{path}.content"),
        }
        if citation_ids is not None:
            out["citationIds"] = citation_ids
        return out
    if kind == "moveBlock":
        v = _object(value, path, ["type", "blockId", "expectedVersion", "parentId"], ["afterId"])
        block_id, version = guard(v)
        return {
            "type": "moveBlock",
            "blockId": block_id,
            "expectedVersion": version,
            "parentId": _parent(v["parentId"], f"{path}.parentId"),
            **after(v),
        }
    if kind == "deleteBlock":
        v = _object(value, path, ["type", "blockId", "expectedVersion"])
        block_id, version = guard(v)
        return {"type": "deleteBlock", "blockId": block_id, "expectedVersion": version}
    if kind == "setTitle":
        v = _object(value, path, ["type", "title"])
        return {"type": "setTitle", "title": _string(v["title"], f"{path}.title", 1_000)}
    if kind == "setFormat":
        v = _object(value, path, ["type", "format"])
        return {"type": "setFormat", "format": _format(v["format"], f"{path}.format")}
    if kind == "addCitation":
        v = _object(value, path, ["type", "citation"])
        return {"type": "addCitation", "citation": _citation(v["citation"], f"{path}.citation")}
    if kind == "insertBlocks":
        v = _object(value, path, ["type", "blocks"], ["afterId"])
        blocks = _array(v["blocks"], f"{path}.blocks", int(LIMITS["blocksPerOperation"]), _block_input)
        if not blocks:
            _fail("insertBlocks requires at least one block.", f"{path}.blocks")
        _unique([b["id"] for b in blocks], f"{path}.blocks", "Each inserted block needs its own new ID.")
        return {"type": "insertBlocks", "blocks": blocks, **after(v)}
    if kind == "duplicateBlock":
        v = _object(value, path, ["type", "blockId", "expectedVersion", "newIds"], ["afterId"])
        block_id = _id(v["blockId"], f"{path}.blockId")
        new_ids = _id_map(v["newIds"], f"{path}.newIds")
        if block_id not in new_ids:
            _fail(
                "newIds must include the duplicated block itself.", f"{path}.newIds", f'Add "{block_id}": "<new id>".'
            )
        return {
            "type": "duplicateBlock",
            "blockId": block_id,
            "expectedVersion": _integer(v["expectedVersion"], f"{path}.expectedVersion", 1),
            "newIds": new_ids,
            **after(v),
        }
    if kind == "replaceText":
        v = _object(value, path, ["type", "blockId", "expectedVersion", "find", "replace"], ["all", "caseSensitive"])
        block_id, version = guard(v)
        out = {
            "type": "replaceText",
            "blockId": block_id,
            "expectedVersion": version,
            "find": _string(v["find"], f"{path}.find", LIMITS["searchText"], False),
            "replace": _string(v["replace"], f"{path}.replace"),
        }
        if "all" in v:
            out["all"] = _boolean(v["all"], f"{path}.all")
        if "caseSensitive" in v:
            out["caseSensitive"] = _boolean(v["caseSensitive"], f"{path}.caseSensitive")
        return out
    if kind == "deleteBlocks":
        v = _object(value, path, ["type", "blocks"])
        return {"type": "deleteBlocks", "blocks": _block_refs(v["blocks"], f"{path}.blocks")}
    if kind == "moveBlocks":
        v = _object(value, path, ["type", "blocks", "parentId"], ["afterId"])
        return {
            "type": "moveBlocks",
            "blocks": _block_refs(v["blocks"], f"{path}.blocks"),
            "parentId": _parent(v["parentId"], f"{path}.parentId"),
            **after(v),
        }
    if kind == "updateCitation":
        v = _object(value, path, ["type", "citation"])
        return {"type": "updateCitation", "citation": _citation(v["citation"], f"{path}.citation")}
    if kind == "removeCitation":
        v = _object(value, path, ["type", "citationId"])
        return {"type": "removeCitation", "citationId": _id(v["citationId"], f"{path}.citationId")}
    return _fail("Unsupported operation type.", f"{path}.type", f"Use one of: {', '.join(OPERATION_TYPES)}.")


def _json_length(value: Any) -> int:
    import json

    return js_length(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _validate(reader: Any) -> dict[str, Any]:
    try:
        return {"ok": True, "value": reader()}
    except Invalid as error:
        return {"ok": False, "issues": [error.issue]}
    except (RecursionError, OverflowError, ValueError, TypeError):
        return {"ok": False, "issues": [{"code": "validation", "message": "Input could not be safely read."}]}


def validate_transaction(value: Any) -> dict[str, Any]:
    def read() -> dict[str, Any]:
        v = _object(value, "transaction", ["id", "actor", "baseRevision", "operations"], ["conflictPolicy"])
        size = 0

        def parse_operation(entry: Any, path: str) -> dict[str, Any]:
            nonlocal size
            parsed = _operation(entry, path)
            size += _json_length(parsed)
            if size > LIMITS["json"]:
                _fail("Transaction exceeds the supported serialized size.", "transaction")
            return parsed

        operations = _array(v["operations"], "transaction.operations", int(LIMITS["operations"]), parse_operation)
        if not operations:
            _fail(
                "A transaction requires at least one operation.",
                "transaction.operations",
                'Add at least one operation, for example {"type":"setTitle","title":"..."}.',
            )
        transaction_id = _id(v["id"], "transaction.id")
        if transaction_id.startswith("history:"):
            _fail(
                "The history: transaction namespace is reserved.",
                "transaction.id",
                'Choose a transaction ID that does not start with "history:".',
            )
        out: dict[str, Any] = {
            "id": transaction_id,
            "actor": read_actor(v["actor"], "transaction.actor"),
            "baseRevision": _integer(v["baseRevision"], "transaction.baseRevision"),
            "operations": operations,
        }
        if "conflictPolicy" in v:
            out["conflictPolicy"] = _enumeration(
                v["conflictPolicy"], "transaction.conflictPolicy", ["reject", "rebase-safe"]
            )
        return out

    return _validate(read)


def validate_history_request(actor: Any, expected_revision: Any) -> dict[str, Any]:
    return _validate(
        lambda: {"actor": read_actor(actor), "expectedRevision": _integer(expected_revision, "expectedRevision")}
    )


def _runs_of(content: dict[str, Any]) -> list[dict[str, Any]] | None:
    return content["runs"] if content["type"] in ("paragraph", "quote", "callout") else None


def validate_document(value: Any) -> dict[str, Any]:  # noqa: C901
    def read() -> dict[str, Any]:  # noqa: C901, PLR0912
        v = _object(
            value,
            "document",
            [
                "schemaVersion",
                "id",
                "title",
                "revision",
                "createdAt",
                "updatedAt",
                "format",
                "blocks",
                "citations",
                "retiredBlockIds",
            ],
        )
        _integer(v["schemaVersion"], "document.schemaVersion", 1, 1)
        size = 0

        def parse_block(entry: Any, path: str) -> dict[str, Any]:
            nonlocal size
            parsed = _block_input(entry, path, True)
            size += _json_length(parsed)
            if size > LIMITS["json"]:
                _fail("Document exceeds the supported serialized size.", "document")
            return parsed

        blocks = _array(v["blocks"], "document.blocks", int(LIMITS["blocks"]), parse_block)
        citations = _array(v["citations"], "document.citations", int(LIMITS["citations"]), _citation)
        retired = _array(v["retiredBlockIds"], "document.retiredBlockIds", 100_000, _id)
        _unique([b["id"] for b in blocks], "document.blocks")
        _unique([c["id"] for c in citations], "document.citations")
        _unique(retired, "document.retiredBlockIds")
        by_id = {b["id"]: b for b in blocks}
        citation_ids = {c["id"] for c in citations}
        depth: dict[str, int] = {}
        for block in blocks:
            for reference in block["citationIds"]:
                if reference not in citation_ids:
                    _fail(
                        "Citation reference does not exist.",
                        f"document.blocks.{block['id']}.citationIds",
                        f'Add citation "{reference}" with addCitation (the same transaction is fine) '
                        "or remove the reference.",
                    )
            for index, run in enumerate(_runs_of(block["content"]) or []):
                if "citationId" in run and run["citationId"] not in citation_ids:
                    _fail(
                        "Inline citation reference does not exist.",
                        f"document.blocks.{block['id']}.content.runs[{index}].citationId",
                        f'Add citation "{run["citationId"]}" with addCitation (the same transaction is fine) '
                        "or remove citationId from the run.",
                    )
            chain: dict[str, None] = {}
            cursor: dict[str, Any] | None = block
            parent_depth = 0
            while cursor is not None and cursor["id"] not in depth:
                if cursor["id"] in chain:
                    _fail("Section ancestry contains a cycle.", f"document.blocks.{block['id']}.parentId")
                chain[cursor["id"]] = None
                if len(chain) > LIMITS["depth"]:
                    _fail(
                        f"Document nesting exceeds {LIMITS['depth']} levels.", f"document.blocks.{block['id']}.parentId"
                    )
                if cursor["parentId"] is None:
                    cursor = None
                    break
                ancestor = by_id.get(cursor["parentId"])
                if ancestor is None or ancestor["content"]["type"] not in CONTAINER_TYPES:
                    _fail(
                        "Parent must reference an existing section or toggle.",
                        f"document.blocks.{cursor['id']}.parentId",
                        "Only section and toggle blocks can contain other blocks. Insert the container first "
                        "(earlier in the same batch is fine) or use parentId: null.",
                    )
                cursor = ancestor
            if cursor is not None:
                parent_depth = depth.get(cursor["id"], 0)
            for entry_id in reversed(list(chain)):
                parent_depth += 1
                if parent_depth > LIMITS["depth"]:
                    _fail(
                        f"Document nesting exceeds {LIMITS['depth']} levels.", f"document.blocks.{block['id']}.parentId"
                    )
                depth[entry_id] = parent_depth
        result: dict[str, Any] = {
            "schemaVersion": 1,
            "id": _id(v["id"], "document.id"),
            "title": _string(v["title"], "document.title", 1_000),
            "revision": _integer(v["revision"], "document.revision"),
            "createdAt": timestamp(v["createdAt"], "document.createdAt"),
            "updatedAt": timestamp(v["updatedAt"], "document.updatedAt"),
            "format": _format(v["format"], "document.format"),
            "blocks": blocks,
            "citations": citations,
            "retiredBlockIds": retired,
        }
        if timestamp_millis(result["createdAt"]) > timestamp_millis(result["updatedAt"]):
            _fail("Document update timestamp precedes creation.", "document.updatedAt")
        document_updated = timestamp_millis(result["updatedAt"])
        for block in blocks:
            created, updated = timestamp_millis(block["createdAt"]), timestamp_millis(block["updatedAt"])
            if created > updated or updated > document_updated:
                _fail(
                    "Block timestamps must follow creation and not exceed the document update timestamp.",
                    f"document.blocks.{block['id']}.updatedAt",
                )
        if _json_length(result) > LIMITS["json"]:
            _fail("Document exceeds the supported serialized size.", "document")
        return result

    return _validate(read)


def create_document(document_id: str, title: str, now: str) -> dict[str, Any]:
    """An empty revision-0 document; raises ValueError when the id, title or timestamp is invalid."""
    at = timestamp(now, "options.now")
    result = validate_document(
        {
            "schemaVersion": 1,
            "id": document_id,
            "title": title,
            "revision": 0,
            "createdAt": at,
            "updatedAt": at,
            "format": {"page": "screen", "font": "sans", "fontSize": 16, "lineHeight": 1.6},
            "blocks": [],
            "citations": [],
            "retiredBlockIds": [],
        }
    )
    if not result["ok"]:
        raise ValueError(result["issues"][0]["message"])
    value: dict[str, Any] = result["value"]
    return value

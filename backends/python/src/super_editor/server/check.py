# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""Input checking for actions: a copy that only holds JSON, and the JSON Schema subset the action schemas use."""

from __future__ import annotations

import json
import math
import re
from functools import lru_cache
from typing import Any, NoReturn

from .._common import js_number
from ..validation import _js_key_order, js_length

MAX_DEPTH = 40
MAX_NODES = 400_000
MAX_ARRAY = 100_000
MAX_SAFE = 9007199254740991


class ActionIssue(Exception):
    """A rejected input; run turns it into a failure result."""

    def __init__(self, issue: dict[str, Any]) -> None:
        super().__init__(issue.get("message", ""))
        self.issue = issue


def reject(code: str, message: str, hint: str = "", **extra: Any) -> NoReturn:
    issue: dict[str, Any] = {"code": code, "message": message}
    for key, value in extra.items():
        if value:
            issue[key] = value
    if hint:
        issue["hint"] = hint
    raise ActionIssue(issue)


def fail(message: str, path: str, hint: str = "") -> NoReturn:
    reject("validation", message, hint, path=path)


def normalize_number(value: float) -> int | float:
    if value.is_integer() and abs(value) <= MAX_SAFE:
        return int(value)
    return value


def plain_copy(value: Any, path: str) -> Any:  # noqa: C901
    """Copy untrusted input into dicts, lists, strings, numbers, booleans and None; reject what JSON cannot carry."""
    nodes = 0

    def walk(v: Any, at: str, depth: int) -> Any:
        nonlocal nodes
        nodes += 1
        if nodes > MAX_NODES:
            fail("Input is too large.", at, "Send less data per call.")
        if v is None or isinstance(v, (str, bool)):
            return v
        if isinstance(v, int):
            return v
        if isinstance(v, float):
            if math.isnan(v) or math.isinf(v):
                fail("Numbers must be finite.", at)
            return normalize_number(v)
        if isinstance(v, (list, tuple)):
            if depth > MAX_DEPTH:
                fail("Input is nested too deeply.", at)
            if len(v) > MAX_ARRAY:
                fail("Array is too long.", at)
            return [walk(e, f"{at}[{i}]", depth + 1) for i, e in enumerate(v)]
        if isinstance(v, dict):
            if depth > MAX_DEPTH:
                fail("Input is nested too deeply.", at)
            out: dict[str, Any] = {}
            for k, e in v.items():
                if not isinstance(k, str):
                    fail(
                        "Only JSON values are accepted.",
                        at,
                        "Use null, booleans, numbers, strings, arrays and plain objects.",
                    )
                out[k] = walk(e, f"{at}.{k}", depth + 1)
            return out
        fail("Only JSON values are accepted.", at, "Use null, booleans, numbers, strings, arrays and plain objects.")

    return walk(value, path, 0)


def type_of(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "integer" if v == math.trunc(v) else "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    return "object"


def matches_type(expected: str, v: Any) -> bool:
    actual = type_of(v)
    return actual == expected or (expected == "number" and actual == "integer")


def pretty(v: Any) -> str:
    if isinstance(v, str):
        return '"' + v + '"'
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "null"
    if isinstance(v, (int, float)):
        return js_number(v)
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


@lru_cache(maxsize=64)
def _pattern(pattern: str) -> re.Pattern[str]:
    # The schemas use ASCII classes and a final $; Python's $ also matches before a trailing newline, \Z does not.
    source = pattern[:-1] + r"\Z" if pattern.endswith("$") else pattern
    return re.compile(source, re.ASCII)


def js_equal(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, str) or isinstance(b, str):
        return isinstance(a, str) and isinstance(b, str) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return bool(a == b)
    return False


def _number(schema: dict[str, Any], key: str) -> int | float | None:
    v = schema.get(key)
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def check(schema: dict[str, Any], value: Any, path: str, root: dict[str, Any]) -> None:  # noqa: C901, PLR0912, PLR0915
    """Panic-free in the Python sense: raises ActionIssue with the first problem, like the reference."""
    ref = schema.get("$ref")
    if isinstance(ref, str):
        target = (root.get("$defs") or {}).get(ref.replace("#/$defs/", "", 1))
        if not isinstance(target, dict):
            fail("Internal schema reference could not be resolved.", path)
        check(target, value, path, root)
        return
    alternatives = schema.get("anyOf")
    if isinstance(alternatives, list):
        first: dict[str, Any] | None = None
        matched = False
        for alt in alternatives:
            try:
                check(alt, value, path, root)
                matched = True
                break
            except ActionIssue as caught:
                if first is None:
                    first = caught.issue
        if not matched:
            hint = schema.get("x-hint") or ""
            if not hint and first is not None:
                hint = first.get("hint") or first.get("message") or ""
            fail("The value does not match any allowed form.", path, hint)
    if "const" in schema and not js_equal(value, schema["const"]):
        fail("Expected " + pretty(schema["const"]) + ".", path)
    options = schema.get("enum")
    if isinstance(options, list) and not any(js_equal(value, e) for e in options):
        joined = ", ".join(pretty(e) for e in options)
        fail("Expected one of: " + joined + ".", path, "Use one of " + joined + ".")
    if "type" in schema:
        declared = schema["type"]
        types = [declared] if isinstance(declared, str) else list(declared)
        if not any(matches_type(t, value) for t in types):
            fail(f"Expected {' or '.join(types)}, received {type_of(value)}.", path, schema.get("description") or "")
    if isinstance(value, str):
        length = js_length(value)
        minimum = _number(schema, "minLength")
        if minimum is not None and length < minimum:
            fail(f"Expected at least {js_number(minimum)} character(s).", path)
        maximum = _number(schema, "maxLength")
        if maximum is not None and length > maximum:
            fail(
                f"Expected at most {js_number(maximum)} characters (received {length}).",
                path,
                "Shorten the text, or split it across several calls.",
            )
        pattern = schema.get("pattern")
        if isinstance(pattern, str) and not _pattern(pattern).search(value):
            fail("Value has an invalid format.", path, schema.get("description") or f"It must match {pattern}.")
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        low = _number(schema, "minimum")
        if low is not None and value < low:
            fail(f"Expected a value of at least {js_number(low)}.", path)
        high = _number(schema, "maximum")
        if high is not None and value > high:
            fail(f"Expected a value of at most {js_number(high)}.", path)
    elif isinstance(value, list):
        low = _number(schema, "minItems")
        if low is not None and len(value) < low:
            fail(f"Expected at least {js_number(low)} item(s).", path)
        high = _number(schema, "maxItems")
        if high is not None and len(value) > high:
            fail(
                f"Expected at most {js_number(high)} items (received {len(value)}).", path, "Send fewer items per call."
            )
        if schema.get("uniqueItems") is True:
            seen = {json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in value}
            if len(seen) != len(value):
                fail("Items must be unique.", path)
        items = schema.get("items")
        if isinstance(items, dict):
            for i, e in enumerate(value):
                check(items, e, f"{path}[{i}]", root)
    elif isinstance(value, dict):
        properties = schema.get("properties") or {}
        for key in schema.get("required") or []:
            if key not in value:
                fail("Required property is missing.", f"{path}.{key}", f'Add "{key}".')
        for key in _js_key_order(list(value)):
            if key not in properties:
                if schema.get("additionalProperties") is False:
                    names = _js_key_order(list(properties))
                    allowed = ", ".join(names) if names else "(none)"
                    fail("Unknown property.", f"{path}.{key}", f"Remove it. Allowed properties: {allowed}.")
                continue
            check(properties[key], value[key], f"{path}.{key}", root)

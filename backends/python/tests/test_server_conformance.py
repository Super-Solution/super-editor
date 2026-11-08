# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""Replays conformance/server.v1.json (generated from the TypeScript HTTP handler) through the Python server."""

from __future__ import annotations

import io
import json
import re
from pathlib import Path
from typing import Any

from super_editor import Editor
from super_editor.server import Cors, EditorService, Handler, Options, Request

DATA: dict[str, Any] = json.loads((Path(__file__).parents[3] / "conformance" / "server.v1.json").read_text("utf-8"))
RANDOM_ID = re.compile(r"^[a-z_]+-[0-9a-f]{16}$")


def normalize(value: Any) -> Any:
    """Blank the random suffix of generated transaction ids, which differ between runs and languages."""
    if isinstance(value, dict):
        return {
            k: (
                v[: v.rindex("-")] + "-RANDOM"
                if k == "transactionId" and isinstance(v, str) and RANDOM_ID.match(v)
                else normalize(v)
            )
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [normalize(v) for v in value]
    return value


def options_of(raw: dict[str, Any]) -> Options:
    options = Options(max_body_bytes=raw.get("maxBodyBytes"), read_only=bool(raw.get("readOnly")))
    if "basePath" in raw:
        options.base_path = raw["basePath"]
    if "actor" in raw:
        options.actor = raw["actor"]
    if "cors" in raw:
        cors = raw["cors"]
        options.cors = Cors(origins=cors["origins"], headers=cors.get("headers", []), max_age=cors.get("maxAge", 600))
    return options


def test_server_conformance() -> None:
    failures: list[str] = []
    for scenario in DATA["scenarios"]:
        clock = {"now": ""}
        editor = Editor(scenario["document"], now=lambda clock=clock: clock["now"])  # type: ignore[misc]
        options = options_of(scenario["options"])
        options.now = lambda clock=clock: clock["now"]  # type: ignore[misc]
        handler = Handler(EditorService(editor), options)
        for index, step in enumerate(scenario["steps"]):
            clock["now"] = step["now"]
            req = step["request"]
            headers = {k.lower(): v for k, v in (req.get("headers") or {}).items()}
            body = req.get("body")
            if body is not None and "x-no-content-type" not in headers and "content-type" not in headers:
                headers["content-type"] = "application/json"
            if body is not None and "x-no-content-type" in headers:
                headers["content-type"] = "text/plain;charset=UTF-8"  # fetch labels a string body without a type
            headers.pop("x-no-content-type", None)
            path, _, query = req["path"].partition("?")
            response = handler.handle(
                Request(
                    req["method"], path, query, headers, io.BytesIO(body.encode("utf-8")) if body is not None else None
                )
            )
            want = step["response"]
            label = f"{scenario['name']} #{index} {req['method']} {req['path']}"
            if response.status != want["status"]:
                failures.append(f"{label}: status {response.status}, want {want['status']}\n  {response.body[:300]!r}")
                continue
            if dict(sorted(response.headers.items())) != want["headers"]:
                failures.append(f"{label}: headers {dict(sorted(response.headers.items()))} want {want['headers']}")
                continue
            if req["method"] == "HEAD":
                continue
            if "json" in want:
                have = normalize(json.loads(response.body))
                if have != normalize(want["json"]):
                    expected = json.dumps(normalize(want["json"]))[:900]
                    failures.append(f"{label}: json\n  got  {json.dumps(have)[:900]}\n  want {expected}")
            elif "text" in want and response.body.decode("utf-8") != want["text"]:
                failures.append(f"{label}: text {response.body[:300]!r} want {want['text'][:300]!r}")
    assert not failures, f"{len(failures)} failures:\n" + "\n".join(failures[:20])

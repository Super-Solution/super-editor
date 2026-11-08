# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""The WSGI adapter: request-line quirks that the recorded HTTP exchanges cannot express."""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

from super_editor import Editor
from super_editor.server import EditorService
from super_editor.server.wsgi import create_wsgi_app

DATA = json.loads((Path(__file__).resolve().parents[3] / "conformance" / "server.v1.json").read_text("utf-8"))


def call(**environ: Any) -> tuple[str, bytes]:
    editor = Editor(DATA["scenarios"][0]["document"])
    app = create_wsgi_app(EditorService(editor))
    seen: dict[str, Any] = {}

    def start_response(status: str, headers: list[tuple[str, str]]) -> None:
        seen["status"] = status

    base: dict[str, Any] = {
        "REQUEST_METHOD": "POST",
        "PATH_INFO": "/transactions",
        "QUERY_STRING": "",
        "wsgi.input": io.BytesIO(b"{}"),
    }
    base.update(environ)
    body = b"".join(app(base, start_response))
    return seen["status"], body


def test_a_content_length_of_non_ascii_digits_is_refused_not_a_crash() -> None:
    # "²".isdigit() is true and int("²") raises: this used to escape as an unhandled error (a 500).
    status, _ = call(CONTENT_LENGTH="²", CONTENT_TYPE="application/json")
    assert status.startswith("413")


def test_a_non_numeric_content_length_is_refused() -> None:
    status, _ = call(CONTENT_LENGTH="abc", CONTENT_TYPE="application/json")
    assert status.startswith("413")

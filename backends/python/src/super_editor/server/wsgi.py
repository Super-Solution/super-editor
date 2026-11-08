# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""WSGI adapter for the HTTP handler, and a small threaded server for local use."""

from __future__ import annotations

import io
from collections.abc import Callable, Iterable
from typing import Any
from urllib.parse import quote

from .http import Handler, Options, Request
from .service import Service

_STATUS = {
    200: "OK", 204: "No Content", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
    409: "Conflict", 413: "Payload Too Large", 415: "Unsupported Media Type", 500: "Internal Server Error",
}  # fmt: skip

WsgiApp = Callable[[dict[str, Any], Callable[..., Any]], Iterable[bytes]]


def _raw_path(environ: dict[str, Any]) -> tuple[str, str]:
    """The percent-encoded path and query string of the request line."""
    for key in ("RAW_URI", "REQUEST_URI", "wsgi_super_editor.raw_uri"):
        raw = environ.get(key)
        if raw:
            path, _, query = str(raw).partition("?")
            if path.startswith(("http://", "https://")):
                path = "/" + path.split("/", 3)[3] if path.count("/") >= 3 else "/"
            return path, query
    return quote(environ.get("PATH_INFO", "") or "/", safe="/:@!$&'()*+,;=-._~"), environ.get("QUERY_STRING", "")


def create_wsgi_app(service: Service, options: Options | None = None) -> WsgiApp:
    """The HTTP API as a WSGI application. It authenticates nobody: put it behind your own gateway."""
    handler = Handler(service, options)

    def app(environ: dict[str, Any], start_response: Callable[..., Any]) -> Iterable[bytes]:
        headers = {
            key[5:].replace("_", "-").lower(): value for key, value in environ.items() if key.startswith("HTTP_")
        }
        if environ.get("CONTENT_TYPE"):
            headers["content-type"] = environ["CONTENT_TYPE"]
        length = environ.get("CONTENT_LENGTH") or ""
        if length:
            headers["content-length"] = length
        body: Any = None
        if length not in ("", "0") or headers.get("transfer-encoding") == "chunked":
            stream = environ["wsgi.input"]
            body = _Limited(stream, int(length)) if length.isdigit() else stream
        path, query = _raw_path(environ)
        response = handler.handle(Request(environ["REQUEST_METHOD"], path, query, headers, body))
        reason = _STATUS.get(response.status, "OK")
        out = list(response.headers.items())
        if response.status != 204:
            out.append(("content-length", str(len(response.body))))
        start_response(f"{response.status} {reason}", out)
        return [response.body]

    return app


class _Limited(io.RawIOBase):
    """A request body that never reads past its Content-Length."""

    def __init__(self, stream: Any, length: int) -> None:
        self._stream = stream
        self._left = length

    def readable(self) -> bool:
        return True

    def read(self, size: int = -1) -> bytes:
        size = self._left if size < 0 else min(size, self._left)
        data: bytes = self._stream.read(size) if size > 0 else b""
        self._left -= len(data)
        return data

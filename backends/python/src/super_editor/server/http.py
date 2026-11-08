# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""The HTTP API as a framework-neutral handler: a Request goes in, a Response comes out. ``wsgi`` adapts it to WSGI.

Every failure has the same JSON shape ``{ok: false, issues: [{code, message, path?, hint}], currentRevision}``. The
handler binds no port and authenticates nobody: the host does, before forwarding a request.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, BinaryIO

from ..inline import js_trim
from ..validation import js_length
from .actions import Context, failure, run_action
from .service import Service, revision_of
from .spec import QueryParam, Route, limit, spec
from .templates import clean_subject, create_template, is_template_kind, template_title

EXPOSED_HEADERS = "x-document-revision"
_MAX_SAFE = 9007199254740991


@dataclass
class Cors:
    """Cross-origin access. It is off unless set; only enable it behind your own auth."""

    origins: list[str] | str = field(default_factory=list)
    """``"*"`` or the exact origins allowed."""
    headers: list[str] = field(default_factory=list)
    """Extra request headers allowed in preflight; content-type is always allowed."""
    max_age: int = 600


@dataclass
class Request:
    """One HTTP request. ``path`` is the percent-encoded path without the query; header names are lower case."""

    method: str
    path: str
    query: str = ""
    headers: Mapping[str, str] = field(default_factory=dict)
    body: BinaryIO | None = None


@dataclass
class Response:
    status: int
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""

    def set(self, name: str, value: str) -> None:
        self.headers[name] = value

    def append(self, name: str, value: str) -> None:
        self.headers[name] = f"{self.headers[name]}, {value}" if name in self.headers else value


@dataclass
class Options:
    max_body_bytes: int | None = None
    """The largest accepted request body. Default 1 MiB."""
    actor: dict[str, str] | Callable[[Request], dict[str, str]] | None = None
    """Provenance recorded on edits, derived from the authenticated request. When set it wins over any actor in a
    request body; otherwise the body's actor is used, then ``{id: "http-client", kind: "agent"}``."""
    read_only: bool = False
    cors: Cors | None = None
    base_path: str = ""
    """Stripped before routing, for a handler mounted below a sub-path (``/api/reports/42``)."""
    now: Callable[[], str] | None = None


class Problem(Exception):
    """A request-level error raised inside route handlers."""

    def __init__(self, status: int, message: str, hint: str = "", path: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.issue: dict[str, Any] = {"code": "validation", "message": message}
        if path:
            self.issue["path"] = path
        if hint:
            self.issue["hint"] = hint


def _encode(value: Any) -> bytes:
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    try:
        return text.encode("utf-8")
    except UnicodeEncodeError:
        return json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode("ascii")


def _base_headers(content_type: str) -> dict[str, str]:
    return {"content-type": content_type, "cache-control": "no-store", "x-content-type-options": "nosniff"}


def _json(value: Any, status: int = 200, extra: Mapping[str, str] | None = None) -> Response:
    response = Response(status, _base_headers("application/json; charset=utf-8"), _encode(value))
    response.headers.update(extra or {})
    return response


def _text(text: str, media_type: str, extra: Mapping[str, str] | None = None) -> Response:
    response = Response(200, _base_headers(media_type + "; charset=utf-8"), text.encode("utf-8", "replace"))
    response.headers.update(extra or {})
    return response


def _failure(
    service: Service, issues: list[dict[str, Any]], status: int, extra: Mapping[str, str] | None = None
) -> Response:
    return _json(failure(service, issues), status, extra)


def _status_for(issues: list[dict[str, Any]], legacy: bool) -> int:
    codes = {i.get("code") for i in issues}
    if "conflict" in codes:
        return 409
    if not legacy and (codes & {"duplicate", "history"}):
        return 409
    if not legacy and "not-found" in codes:
        return 404
    return 400


_ACTOR_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]*\Z", re.ASCII)


def _read_actor(value: Any, path: str) -> dict[str, str]:
    def bad() -> Problem:
        return Problem(
            400,
            "Expected an actor: { id, kind }.",
            "kind is one of human, agent or system; id uses letters, digits and . _ : - .",
            path,
        )

    if not isinstance(value, dict) or any(k not in ("id", "kind") for k in value):
        raise bad()
    ident, kind = value.get("id"), value.get("kind")
    if (
        not isinstance(ident, str)
        or js_length(ident) > 128
        or not _ACTOR_ID.match(ident)
        or kind not in ("human", "agent", "system")
    ):
        raise bad()
    return {"id": ident, "kind": kind}


# ---- request helpers ------------------------------------------------------------------------------------------------


def _hex_byte(text: str) -> int | None:
    if len(text) != 2 or any(ch not in "0123456789abcdefABCDEF" for ch in text):
        return None
    return int(text, 16)


def percent_decode(text: str) -> str | None:
    """decodeURIComponent: None for a malformed escape or bytes that are not UTF-8."""
    out = bytearray()
    i = 0
    raw = text.encode("utf-8", "surrogatepass")
    while i < len(raw):
        if raw[i] != 0x25:
            out.append(raw[i])
            i += 1
            continue
        value = _hex_byte(raw[i + 1 : i + 3].decode("latin-1")) if i + 3 <= len(raw) else None
        if value is None:
            return None
        out.append(value)
        i += 3
    try:
        return out.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _lenient_decode(text: str) -> str:
    """URLSearchParams decoding: '+' is a space, bad escapes stay as they are, invalid UTF-8 becomes U+FFFD."""
    raw = text.replace("+", " ").encode("utf-8", "surrogatepass")
    out = bytearray()
    i = 0
    while i < len(raw):
        if raw[i] == 0x25 and i + 3 <= len(raw):
            value = _hex_byte(raw[i + 1 : i + 3].decode("latin-1"))
            if value is not None:
                out.append(value)
                i += 3
                continue
        out.append(raw[i])
        i += 1
    return out.decode("utf-8", "replace")


def _query_pairs(raw: str) -> list[tuple[str, str]]:
    pairs = []
    for part in raw.split("&"):
        if part == "":
            continue
        key, _, value = part.partition("=")
        pairs.append((_lenient_decode(key), _lenient_decode(value)))
    return pairs


_INTEGER = re.compile(r"[0-9]{1,15}\Z")


def parse_query(raw: str, defs: tuple[QueryParam, ...]) -> dict[str, Any]:  # noqa: C901, PLR0912
    """Turn a query string into action input following the route's parameter definitions."""
    pairs = _query_pairs(raw)
    out: dict[str, Any] = {}
    for key in dict.fromkeys(k for k, _ in pairs):
        definition = next((d for d in defs if d.name == key), None)
        path = "query." + key
        if definition is None:
            hint = (
                "Allowed parameters: " + ", ".join(d.name for d in defs) + "."
                if defs
                else "This route takes no query parameters."
            )
            raise Problem(400, f'Unknown query parameter "{key}".', hint, path)
        values = [v for k, v in pairs if k == key]
        if definition.type != "list" and len(values) > 1:
            raise Problem(400, f'Query parameter "{key}" was given more than once.', "Send it once.", path)
        value = values[0]
        if definition.type == "list":
            out[definition.field] = [e for v in values for e in (js_trim(part) for part in v.split(",")) if e]
        elif definition.type == "integer":
            if not _INTEGER.match(value):
                raise Problem(400, f'Query parameter "{key}" must be a non-negative integer.', "", path)
            out[definition.field] = int(value)
        elif definition.type == "boolean":
            if value in ("true", "1"):
                out[definition.field] = True
            elif value in ("false", "0"):
                out[definition.field] = False
            else:
                raise Problem(400, f'Query parameter "{key}" must be true or false.', "", path)
        elif definition.nullable and value == "null":
            out[definition.field] = None
        else:
            if definition.enum and value not in definition.enum:
                raise Problem(400, f'Query parameter "{key}" must be one of: {", ".join(definition.enum)}.', "", path)
            out[definition.field] = value
    return out


# ---- routing --------------------------------------------------------------------------------------------------------


def match_route(method: str, pathname: str) -> tuple[tuple[Route, dict[str, str]] | None, list[str]]:
    """The route for a request, or the methods the path does support (for 405 and OPTIONS)."""
    allow: list[str] = []
    segments = pathname.split("/")
    for route in spec().routes:
        template = route.path.split("/")
        if len(template) != len(segments):
            continue
        names: dict[str, str] = {}
        ok = True
        for t, s in zip(template, segments, strict=True):
            if t.startswith("{") and t.endswith("}"):
                if s == "":
                    ok = False
                    break
                names[t[1:-1]] = s
            elif t != s:
                ok = False
                break
        if not ok:
            continue
        if route.method != method:
            if route.method not in allow:
                allow.append(route.method)
            continue
        params = {}
        for key, raw in names.items():
            decoded = percent_decode(raw)
            if decoded is None:
                raise Problem(400, "The path contains invalid percent-encoding.", "", "path")
            params[key] = decoded
        return (route, params), []
    return None, allow


def normalize_path(path: str) -> str:
    """The dot-segment rules of a URL parser."""
    if not path.startswith("/"):
        path = "/" + path
    segments = path[1:].split("/")
    out: list[str] = []
    for i, segment in enumerate(segments):
        lower = segment.lower()
        if lower in (".", "%2e"):
            if i == len(segments) - 1:
                out.append("")
        elif lower in ("..", ".%2e", "%2e.", "%2e%2e"):
            if out:
                out.pop()
            if i == len(segments) - 1:
                out.append("")
        else:
            out.append(segment)
    return "/" + "/".join(out)


# ---- the handler ----------------------------------------------------------------------------------------------------


def _parse_int(text: str) -> int | float:
    if len(text) <= 15:
        return int(text)
    value = float(text)
    return int(value) if abs(value) <= _MAX_SAFE else value


def _parse_float(text: str) -> int | float:
    value = float(text)
    return int(value) if value.is_integer() and abs(value) <= _MAX_SAFE else value


def _reject_constant(name: str) -> Any:
    raise ValueError(name)


def decode_json(text: str) -> Any:
    """JSON.parse: numbers become int when they hold an integer, NaN and Infinity are refused."""
    return json.loads(text, parse_int=_parse_int, parse_float=_parse_float, parse_constant=_reject_constant)


class _Req:
    def __init__(self, request: Request, path: str, params: dict[str, str], opts: Options, byte_limit: int) -> None:
        self.request = request
        self.path = path
        self.query = request.query
        self.params = params
        self.opts = opts
        self.limit = byte_limit
        self._raw: bytes | None = None

    def media_type(self) -> str:
        content_type = self.request.headers.get("content-type", "")
        return content_type.split(";")[0].strip().lower() if content_type else ""

    def bytes(self) -> bytes:
        if self._raw is not None:
            return self._raw

        def too_large() -> Problem:
            return Problem(
                413,
                f"The request body exceeds {self.limit} bytes.",
                "Send less data per request: split large inserts into several calls.",
            )

        declared = self.request.headers.get("content-length")
        if declared and (not re.fullmatch(r"[0-9]+", declared) or int(declared) > self.limit):
            raise too_large()
        if self.request.body is None:
            raise Problem(400, "A request body is required.")
        try:
            data = self.request.body.read(self.limit + 1)
        except Exception:  # noqa: BLE001
            raise Problem(400, "The request body could not be read.") from None
        if len(data) > self.limit:
            raise too_large()
        self._raw = data
        return data

    def text(self) -> str:
        data = self.bytes()
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise Problem(400, "The request body is not valid UTF-8.") from None
        return text[1:] if text.startswith("﻿") else text

    def body(self) -> Any:
        kind = self.media_type()
        if kind and kind != "application/json":
            raise Problem(
                415,
                "Content-Type must be application/json.",
                "Send the body as JSON with Content-Type: application/json.",
            )
        try:
            return decode_json(self.text())
        except (ValueError, RecursionError):
            raise Problem(400, "The request body is not valid JSON.", "Send one JSON value.") from None

    def actor(self, supplied: Any = None, has: bool = False) -> dict[str, str]:
        if self.opts.actor is not None:
            return dict(self.opts.actor(self.request)) if callable(self.opts.actor) else dict(self.opts.actor)
        if not has:
            return {"id": "http-client", "kind": "agent"}
        return _read_actor(supplied, "body.actor")

    def context(self, supplied: Any = None, has: bool = False) -> Context:
        return Context(self.actor(supplied, has), self.opts.now)


_BASE_PATH = re.compile(r"/[^?#]*[^/?#]\Z")
_EXPORT_TYPES = {"export_markdown": "text/markdown", "export_html": "text/html", "export_text": "text/plain"}


def _split_body(body: dict[str, Any]) -> tuple[dict[str, Any], Any, bool]:
    return {k: v for k, v in body.items() if k != "actor"}, body.get("actor"), "actor" in body


class Handler:
    """``Handler(service, options).handle(request)`` answers one request. It never raises."""

    def __init__(self, service: Service, options: Options | None = None) -> None:
        opts = options or Options()
        byte_limit = opts.max_body_bytes if opts.max_body_bytes is not None else limit("requestBytes")
        if byte_limit < 1:
            raise ValueError("max_body_bytes must be a positive integer")
        if opts.base_path and not _BASE_PATH.match(opts.base_path):
            raise ValueError('base_path must start with "/" and must not end with "/"')
        if opts.cors is not None and opts.cors.origins != "*":
            for origin in opts.cors.origins:
                if origin in ("", "*") or origin.endswith("/"):
                    raise ValueError('CORS origins must be "*" or exact origins such as "https://app.example.com"')
        self.service = service
        self.opts = opts
        self.limit = byte_limit
        self._openapi: bytes | None = None

    def _allowed_origin(self, origin: str | None) -> str | None:
        cors = self.opts.cors
        if cors is None or origin is None:
            return None
        if cors.origins == "*":
            return "*"
        return origin if origin in cors.origins else None

    def handle(self, request: Request) -> Response:  # noqa: C901, PLR0911, PLR0912
        origin = request.headers.get("origin")
        allowed = self._allowed_origin(origin)

        def decorate(response: Response) -> Response:
            if allowed is not None:
                response.set("access-control-allow-origin", allowed)
                response.set("access-control-expose-headers", EXPOSED_HEADERS)
                if allowed != "*":
                    response.append("vary", "origin")
            return response

        def unknown() -> Response:
            issue = {"code": "not-found", "message": "Unknown route.", "hint": "GET /openapi.json lists the routes."}
            return decorate(_failure(self.service, [issue], 404))

        try:
            pathname = normalize_path(request.path)
            base = self.opts.base_path
            if base:
                if pathname != base and not pathname.startswith(base + "/"):
                    issue = {"code": "not-found", "message": "Unknown route.", "hint": f"Routes live under {base}."}
                    return decorate(_failure(self.service, [issue], 404))
                pathname = pathname[len(base) :] or "/"
            method = request.method
            found, allow = match_route("GET" if method == "HEAD" else method, pathname)
            if method == "OPTIONS":
                return self._options(request, allow, origin, allowed, decorate, unknown)
            if found is None and not allow:
                return unknown()
            if found is None:
                issue = {
                    "code": "validation",
                    "message": f"Method {method} is not allowed here.",
                    "hint": "Use " + " or ".join(allow) + ".",
                }
                return decorate(_failure(self.service, [issue], 405, {"allow": ", ".join(allow)}))
            route, params = found
            if self.opts.read_only and route.write:
                issue = {
                    "code": "validation",
                    "message": "This endpoint is read-only.",
                    "hint": "Use a GET route, or ask the operator for a writable endpoint.",
                }
                return decorate(_failure(self.service, [issue], 403))
            response = self._run(route, _Req(request, pathname, params, self.opts, self.limit))
            if method == "HEAD":
                response = Response(response.status, response.headers, b"")
            return decorate(response)
        except Problem as problem:
            return decorate(_failure(self.service, [problem.issue], problem.status))
        except Exception:  # noqa: BLE001 - the handler must always answer
            issue = {
                "code": "validation",
                "message": "The request could not be processed safely.",
                "hint": "Retry; if it keeps failing, report it with the route and body.",
            }
            return decorate(_failure(self.service, [issue], 500))

    def _options(
        self,
        request: Request,
        allow: list[str],
        origin: str | None,
        allowed: str | None,
        decorate: Callable[[Response], Response],
        unknown: Callable[[], Response],
    ) -> Response:
        if not allow:
            return unknown()
        allow_header = ", ".join([*allow, "OPTIONS"])
        cors = self.opts.cors
        if "access-control-request-method" in request.headers and origin is not None and cors is not None:
            if allowed is None:
                issue = {
                    "code": "validation",
                    "message": "This origin is not allowed.",
                    "hint": "Ask the operator to add the origin to the CORS allow-list.",
                }
                return _failure(self.service, [issue], 403)
            response = Response(
                204,
                {
                    "allow": allow_header,
                    "access-control-allow-origin": allowed,
                    "access-control-allow-methods": allow_header,
                    "access-control-max-age": str(cors.max_age or 600),
                    "cache-control": "no-store",
                },
            )
            if "access-control-request-headers" in request.headers and cors.headers:
                response.set("access-control-allow-headers", ", ".join(["content-type", *cors.headers]))
            else:
                response.set("access-control-allow-headers", "content-type")
            if allowed != "*":
                response.append("vary", "origin")
            return response
        return decorate(Response(204, {"allow": allow_header, "cache-control": "no-store"}))

    def _respond_action(self, result: dict[str, Any], legacy: bool = False) -> Response:
        if result.get("ok") is True:
            return _json(result)
        issues = result["issues"]
        return _failure(self.service, issues, _status_for(issues, legacy))

    def _apply_response(self, result: dict[str, Any]) -> Response:
        if result["ok"]:
            out: dict[str, Any] = {"ok": True, "document": result["document"], "revision": result["revision"]}
            if result.get("duplicate"):
                out["duplicate"] = True
            return _json(out)
        return _failure(self.service, result["issues"], _status_for(result["issues"], True))

    def _action(self, name: str, value: Any, context: Context) -> dict[str, Any]:
        return run_action(self.service, name, value, context)

    def _run(self, route: Route, q: _Req) -> Response:  # noqa: C901, PLR0911, PLR0912
        s = self.service
        op = route.operation_id
        if op == "read_document":
            return _json(s.read())
        if op == "apply_transaction":
            return self._apply_response(s.apply(q.body()))
        if op in ("undo", "redo"):
            body = q.body()
            if not isinstance(body, dict) or any(k not in ("actor", "expectedRevision") for k in body):
                issue = {"code": "validation", "message": "History request requires only actor and expectedRevision."}
                return _failure(s, [issue], 400)
            step = s.undo if op == "undo" else s.redo
            return self._apply_response(step(body.get("actor"), body.get("expectedRevision")))
        if op in ("get_outline", "find_blocks", "get_block", "document_stats", "list_revisions"):
            value = parse_query(q.query, route.query)
            if op == "get_block":
                value["blockId"] = q.params["id"]
            return self._respond_action(self._action(op, value, q.context()))
        if op in _EXPORT_TYPES:
            value = parse_query(q.query, route.query)
            if op == "export_html" and "standalone" not in value:
                value["standalone"] = True
            result = self._action(op, value, q.context())
            if result.get("ok") is not True:
                return _failure(s, result["issues"], _status_for(result["issues"], False))
            media = _EXPORT_TYPES[op]
            extra = {"x-document-revision": str(result["revision"])}
            if media == "text/html":
                extra["content-security-policy"] = (
                    "default-src 'none'; img-src https:; style-src 'unsafe-inline'; sandbox"
                )
            return _text(result["text"], media, extra)
        if op == "import_markdown":
            return self._import_markdown(route, q)
        if op == "list_templates":
            return self._respond_action(self._action("list_templates", {}, q.context()))
        if op == "preview_template":
            return self._preview_template(q, route)
        if op == "list_actions":
            keys = ("name", "title", "description", "access", "destructive", "idempotent", "inputSchema")
            actions = [{k: a.raw[k] for k in keys} for a in spec().actions]
            return _json({"ok": True, "revision": revision_of(s), "actions": actions})
        if op == "run_action":
            return self._run_action(q)
        if op == "openapi":
            if self._openapi is None:
                self._openapi = _encode(self._openapi_document())
            return Response(200, _base_headers("application/json; charset=utf-8"), self._openapi)
        if op == "document_schema":
            return _json(spec().document_schema)
        if op == "transaction_schema":
            return _json(spec().transaction_schema)
        if op == "health":
            return _json({"ok": True, "revision": revision_of(s)})
        issue = {"code": "not-found", "message": "Unknown route.", "hint": "GET /openapi.json lists the routes."}
        return _failure(s, [issue], 404)

    def _openapi_document(self) -> dict[str, Any]:
        source = spec().openapi
        if not self.opts.base_path:
            return source
        out: dict[str, Any] = {}
        for key, value in source.items():
            out[key] = value
            if key == "info":
                out["servers"] = [{"url": self.opts.base_path}]
        return out

    def _run_action(self, q: _Req) -> Response:
        name = q.params["name"]
        action = spec().action_by_name.get(name)
        if action is None:
            names = ", ".join(a.name for a in spec().actions)
            issue = {
                "code": "not-found",
                "message": f'Unknown action "{name}".',
                "hint": f"GET /actions lists them: {names}.",
            }
            return _failure(self.service, [issue], 404)
        if self.opts.read_only and action.access == "write":
            issue = {
                "code": "validation",
                "message": f'This endpoint is read-only; "{name}" can change the document.',
                "hint": "Use a read action, or ask the operator for a writable endpoint.",
            }
            return _failure(self.service, [issue], 403)
        body = q.body()
        if not isinstance(body, dict):
            raise Problem(400, "Expected a JSON object with the action input.", "", "body")
        value, supplied, has_actor = _split_body(body)
        return self._respond_action(self._action(name, value, q.context(supplied, has_actor)))

    def _import_markdown(self, route: Route, q: _Req) -> Response:
        if q.media_type() in ("text/markdown", "text/plain"):
            value = parse_query(q.query, route.query)
            supplied: Any = None
            has_actor = False
            if "actor" in value:
                ident, _, kind = str(value.pop("actor")).partition(":")
                kind = kind.split(":")[0] if kind else "agent"
                supplied, has_actor = {"id": ident, "kind": kind}, True
            value["markdown"] = q.text()
            return self._respond_action(self._action("import_markdown", value, q.context(supplied, has_actor)))
        body = q.body()
        if not isinstance(body, dict):
            raise Problem(
                400,
                "Expected a JSON object.",
                'Send { "markdown": "..." }, or raw markdown with Content-Type text/markdown.',
            )
        value, supplied, has_actor = _split_body(body)
        return self._respond_action(self._action("import_markdown", value, q.context(supplied, has_actor)))

    def _preview_template(self, q: _Req, route: Route) -> Response:
        kind = q.params["kind"]
        if not is_template_kind(kind):
            issue = {
                "code": "not-found",
                "message": f'Unknown template "{kind}".',
                "hint": "Use one of: " + ", ".join(spec().template_kinds) + ".",
            }
            return _failure(self.service, [issue], 404)
        value = parse_query(q.query, route.query)
        prefix = value["idPrefix"] if isinstance(value.get("idPrefix"), str) else kind
        subject_raw = value["subject"] if isinstance(value.get("subject"), str) else ""
        try:
            blocks = create_template(kind, prefix, clean_subject(subject_raw), None)
            title = template_title(kind, subject_raw)
        except ValueError as error:
            raise Problem(400, str(error)) from error
        return _json(
            {"ok": True, "revision": revision_of(self.service), "kind": kind, "title": title, "blocks": blocks}
        )


def create_handler(service: Service, options: Options | None = None) -> Callable[[Request], Response]:
    """The framework-neutral HTTP handler over a service."""
    return Handler(service, options).handle

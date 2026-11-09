# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""``python -m super_editor.server --document report.json``: serve one research document over HTTP.

The handler does not authenticate; run it on a private network or behind your own gateway.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import stat
import sys
import tempfile
import threading
from socketserver import ThreadingMixIn
from typing import Any
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

from ..editor import Editor
from .actions import current_iso
from .http import Cors, Options
from .service import EditorService, Service
from .spec import limit
from .wsgi import create_wsgi_app


def _write_atomic(path: str, document: dict[str, Any]) -> None:
    """Replace ``path`` with a fully written temporary file.

    A symlink is followed (the link stays a link), the permission bits of the existing file are kept, and the
    temporary name is unique and created exclusively, so nothing can be pre-planted at it.
    """
    target = os.path.realpath(path)
    try:
        mode: int | None = stat.S_IMODE(os.stat(target).st_mode)
    except FileNotFoundError:
        mode = None
    descriptor, temporary = tempfile.mkstemp(
        dir=os.path.dirname(target), prefix=f".{os.path.basename(target)}.", suffix=".tmp"
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            if mode is not None and hasattr(os, "fchmod"):
                os.fchmod(handle.fileno(), mode)
            json.dump(document, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temporary)
        raise


class _Saving:
    """A service that writes the document back after every accepted edit (temporary file, then rename). Edits and
    their saves are serialized, so concurrent requests cannot interleave on the temporary file."""

    def __init__(self, inner: Service, path: str) -> None:
        self._inner = inner
        self._path = path
        self._lock = threading.Lock()

    def read(self) -> dict[str, Any]:
        return self._inner.read()

    def revisions(self) -> list[dict[str, Any]]:
        return self._inner.revisions()

    def _save(self, result: dict[str, Any]) -> dict[str, Any]:
        if result.get("ok") and not result.get("duplicate"):
            try:
                _write_atomic(self._path, self._inner.read())
            except OSError as error:
                print(f"saving {self._path}: {error}", file=sys.stderr)
        return result

    def apply(self, transaction: Any) -> dict[str, Any]:
        with self._lock:
            return self._save(self._inner.apply(transaction))

    def undo(self, actor: Any, expected_revision: Any) -> dict[str, Any]:
        with self._lock:
            return self._save(self._inner.undo(actor, expected_revision))

    def redo(self, actor: Any, expected_revision: Any) -> dict[str, Any]:
        with self._lock:
            return self._save(self._inner.redo(actor, expected_revision))


class _Threaded(ThreadingMixIn, WSGIServer):
    daemon_threads = True


class _Quiet(WSGIRequestHandler):
    def get_environ(self) -> dict[str, Any]:
        environ = super().get_environ()
        environ["wsgi_super_editor.raw_uri"] = self.path
        return environ

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass


def _read_document_text(path: str) -> str:
    """Read the document file, refusing more than the spec's fileBytes (a pipe or device reports size 0)."""
    maximum = limit("fileBytes")
    with open(path, "rb") as handle:
        raw = handle.read(maximum + 1)
    if len(raw) > maximum:
        raise SystemExit(f"{path} is larger than the {maximum} byte limit")
    return raw.decode("utf-8")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m super_editor.server", description=__doc__)
    parser.add_argument("--document", required=True, help="path of the document JSON file")
    parser.add_argument("--addr", default="127.0.0.1:8787", help="listen address (default 127.0.0.1:8787)")
    parser.add_argument("--read-only", action="store_true", help="refuse every route that can change the document")
    parser.add_argument("--save", action="store_true", help="write the document back to the file after every edit")
    parser.add_argument("--base-path", default="", help="path prefix the server is mounted under")
    parser.add_argument("--cors", default="", help='allowed origins, comma separated, or "*" (off by default)')
    parser.add_argument(
        "--max-body-bytes", type=int, default=None, help="largest accepted request body (default 1 MiB)"
    )
    args = parser.parse_args(argv)
    document = json.loads(_read_document_text(args.document))
    service: Service = EditorService(Editor(document, now=current_iso))
    if args.save and not args.read_only:
        service = _Saving(service, args.document)
    cors = None
    if args.cors:
        cors = Cors(origins="*" if args.cors == "*" else args.cors.split(","))
    options = Options(max_body_bytes=args.max_body_bytes, read_only=args.read_only, base_path=args.base_path, cors=cors)
    host, _, port = args.addr.rpartition(":")
    server = make_server(host or "127.0.0.1", int(port), create_wsgi_app(service, options), _Threaded, _Quiet)
    print(f"super-editor-server: {args.document} on http://{args.addr}", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()

# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""The session-scoped facade the actions and the HTTP handler work on."""

from __future__ import annotations

from typing import Any, Protocol

from ..editor import Editor


class Service(Protocol):
    """Persistence and access control belong to the host; a service only reads and changes one document."""

    def read(self) -> dict[str, Any]:
        """The current document. Callers must not modify it."""
        ...

    def apply(self, transaction: Any) -> dict[str, Any]: ...

    def undo(self, actor: Any, expected_revision: Any) -> dict[str, Any]: ...

    def redo(self, actor: Any, expected_revision: Any) -> dict[str, Any]: ...

    def revisions(self) -> list[dict[str, Any]]:
        """The revisions of the session, oldest first."""
        ...


class EditorService:
    """A Service over an Editor."""

    def __init__(self, editor: Editor) -> None:
        self._editor = editor

    def read(self) -> dict[str, Any]:
        return self._editor.snapshot

    def apply(self, transaction: Any) -> dict[str, Any]:
        return self._editor.apply(transaction)

    def undo(self, actor: Any, expected_revision: Any) -> dict[str, Any]:
        return self._editor.undo(actor, expected_revision)

    def redo(self, actor: Any, expected_revision: Any) -> dict[str, Any]:
        return self._editor.redo(actor, expected_revision)

    def revisions(self) -> list[dict[str, Any]]:
        return self._editor.revisions


def revision_of(service: Service) -> int:
    return int(service.read()["revision"])

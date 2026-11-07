# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""Guarded transactions for Super Editor documents, in Python.

Mirrors packages/core/src/editor.ts for a deliberate subset: flat documents (every block has
parentId null) and the operations insertBlock, updateBlock, moveBlock, deleteBlock and setTitle.
What it reproduces exactly: base-revision and per-block version guards, atomic all-or-nothing
application, block version and revision counters, retired block IDs that can never be reused,
and idempotent retry of the last successful transaction. conformance/guarded-apply.v1.json is the
shared test data.

Not covered: content and document schema validation (content is opaque here), nesting,
the other nine operation types, undo/redo, rebase-safe conflicts and the clock-callback API.
"""
from __future__ import annotations

import copy
import json
from typing import Any


class _Rejected(Exception):
    def __init__(self, code: str, block_id: str | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.block_id = block_id


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


class Editor:
    """Session editor over one document. Pass the clock reading to every apply call."""

    def __init__(self, document: dict[str, Any]) -> None:
        self._snapshot = copy.deepcopy(document)
        self._versions = {b["id"]: b["version"] for b in self._snapshot["blocks"]}
        self._reserved = set(self._snapshot["retiredBlockIds"]) | {b["id"] for b in self._snapshot["blocks"]}
        self._seen: set[str] = set()
        self._last: tuple[str, str, dict[str, Any]] | None = None  # id, fingerprint, document

    @property
    def snapshot(self) -> dict[str, Any]:
        return copy.deepcopy(self._snapshot)

    def _failure(self, code: str, block_id: str | None = None) -> dict[str, Any]:
        issue: dict[str, Any] = {"code": code}
        if block_id is not None:
            issue["blockId"] = block_id
        return {"ok": False, "issues": [issue], "currentRevision": self._snapshot["revision"]}

    def apply(self, transaction: dict[str, Any], now: str) -> dict[str, Any]:
        tx_id = transaction["id"]
        fingerprint = _canonical(transaction)
        if tx_id in self._seen:
            if self._last and self._last[0] == tx_id and self._last[1] == fingerprint:
                return {"ok": True, "duplicate": True, "document": copy.deepcopy(self._last[2])}
            return self._failure("duplicate")
        try:
            if transaction.get("conflictPolicy") is not None:
                raise NotImplementedError("conflictPolicy is not part of the proof of concept")
            if transaction["baseRevision"] != self._snapshot["revision"]:
                raise _Rejected("conflict")
            if now < self._snapshot["updatedAt"]:  # ISO UTC strings of one shape sort chronologically
                raise _Rejected("validation")
            nxt = copy.deepcopy(self._snapshot)
            high_water = dict(self._versions)
            pending = set(self._reserved)
            for operation in transaction["operations"]:
                self._operation(nxt, operation, high_water, now, pending)
            nxt["revision"] += 1
            nxt["updatedAt"] = now
        except _Rejected as e:
            return self._failure(e.code, e.block_id)
        self._snapshot = nxt
        self._versions = high_water
        self._reserved |= {b["id"] for b in nxt["blocks"]} | set(nxt["retiredBlockIds"])
        self._seen.add(tx_id)
        self._last = (tx_id, fingerprint, copy.deepcopy(nxt))
        return {"ok": True, "document": copy.deepcopy(nxt)}

    # -- operations -------------------------------------------------------------------------

    @staticmethod
    def _tick(block: dict[str, Any], high_water: dict[str, int], at: str) -> None:
        block["version"] = max(block["version"], high_water.get(block["id"], 0)) + 1
        block["updatedAt"] = at
        high_water[block["id"]] = block["version"]

    @staticmethod
    def _block_at(doc: dict[str, Any], block_id: str, expected: int) -> dict[str, Any]:
        block = next((b for b in doc["blocks"] if b["id"] == block_id), None)
        if block is None:
            raise _Rejected("not-found", block_id)
        if block["version"] != expected:
            raise _Rejected("conflict", block_id)
        return block

    @staticmethod
    def _put(doc: dict[str, Any], block: dict[str, Any], operation: dict[str, Any]) -> None:
        if block["parentId"] is not None:
            raise NotImplementedError("nested blocks are not part of the proof of concept")
        blocks = doc["blocks"]
        if "afterId" not in operation:
            position = len(blocks)  # omission appends
        else:
            after = operation["afterId"]
            if after == block["id"]:
                raise _Rejected("validation", block["id"])
            if after is None:
                position = 0  # null prepends
            else:
                anchor = next((i for i, b in enumerate(blocks) if b["id"] == after), -1)
                if anchor == -1:
                    raise _Rejected("validation", block["id"])
                position = anchor + 1
        blocks.insert(position, block)

    def _operation(self, doc: dict[str, Any], op: dict[str, Any], high_water: dict[str, int], at: str, pending: set[str]) -> None:
        kind = op["type"]
        if kind == "insertBlock":
            incoming = op["block"]
            if incoming["id"] in pending or any(b["id"] == incoming["id"] for b in doc["blocks"]):
                raise _Rejected("duplicate", incoming["id"])
            block = {**copy.deepcopy(incoming), "version": 1, "createdAt": at, "updatedAt": at}
            self._put(doc, block, op)
            high_water[block["id"]] = 1
            pending.add(block["id"])
        elif kind == "updateBlock":
            block = self._block_at(doc, op["blockId"], op["expectedVersion"])
            block["content"] = copy.deepcopy(op["content"])
            if "citationIds" in op:
                block["citationIds"] = list(op["citationIds"])
            self._tick(block, high_water, at)
        elif kind == "moveBlock":
            block = self._block_at(doc, op["blockId"], op["expectedVersion"])
            if op["parentId"] is not None:
                raise NotImplementedError("nested blocks are not part of the proof of concept")
            doc["blocks"].remove(block)
            block["parentId"] = op["parentId"]
            self._put(doc, block, op)
            self._tick(block, high_water, at)
        elif kind == "deleteBlock":
            block = self._block_at(doc, op["blockId"], op["expectedVersion"])
            self._tick(block, high_water, at)
            if block["id"] not in doc["retiredBlockIds"]:
                doc["retiredBlockIds"].append(block["id"])
            doc["blocks"] = [b for b in doc["blocks"] if b["id"] != block["id"]]
        elif kind == "setTitle":
            doc["title"] = op["title"]
        else:
            raise NotImplementedError(f"operation {kind} is not part of the proof of concept")

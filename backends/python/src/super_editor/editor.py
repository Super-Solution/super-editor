# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""The session editor of the Super Editor core, in Python.

Guarded transactions over the full document model (all 17 block types, nested sections and toggles), the 14
operations, rebase-safe stale transactions, undo and redo, and the revision log. It is a port of
packages/core/src/editor.ts and reproduces every case of conformance/editor.v1.json.

Documents and transactions are plain JSON values (dicts, lists, ints, floats, strings). Every input is validated
first and every result document is validated again before it commits. Results share structure with the editor's
snapshot and must not be modified by callers.
"""

from __future__ import annotations

import copy
import json
import threading
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any, NoReturn

from .validation import (
    Invalid,
    timestamp,
    timestamp_millis,
    validate_document,
    validate_history_request,
    validate_transaction,
)

MAX_SAFE = 9007199254740991
_REUSE_HINT = "Choose a fresh ID. IDs of deleted blocks stay reserved so old references cannot point at new content."
_UNSET = object()
"""An ordering anchor that was not given (append); None means "first" and a string a sibling's ID."""


class _Rejected(Exception):
    def __init__(self, issue: dict[str, Any]) -> None:
        super().__init__(issue["message"])
        self.issue = issue


def _reject(code: str, message: str, block_id: str | None = None, hint: str | None = None) -> NoReturn:
    issue: dict[str, Any] = {"code": code, "message": message}
    if block_id:
        issue["blockId"] = block_id
    if hint:
        issue["hint"] = hint
    raise _Rejected(issue)


def _increment(value: int, label: str) -> int:
    if value >= MAX_SAFE:
        _reject("conflict", f"{label} has reached the maximum supported version.")
    return value + 1


def default_hint(issue: dict[str, Any]) -> str:
    """A generic remediation by issue code, used when the specific check did not attach a more precise hint."""
    code = issue["code"]
    if code == "validation":
        if issue.get("path"):
            return (
                f'Compare "{issue["path"]}" with the JSON schemas (documentSchema, transactionSchema) '
                "and the limits in LIMITS."
            )
        return "Compare the input with the JSON schemas (documentSchema, transactionSchema) and the limits in LIMITS."
    if code == "conflict":
        return (
            "Re-read the document, then rebuild the transaction from its current revision and block versions. "
            "Do not retry by removing the guards."
        )
    if code == "not-found":
        return (
            "The block or citation does not exist (any more) or its ID is misspelled. "
            "Read the document to list current IDs."
        )
    if code == "duplicate":
        return "Choose a different ID. IDs of deleted blocks and of already used transactions stay reserved."
    return "Undo and redo only cover edits made in this editor session and need the current document revision."


def with_hints(issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The issues with a hint on every entry, leaving specific hints untouched."""
    return [issue if issue.get("hint") else {**issue, "hint": default_hint(issue)} for issue in issues]


# --- text replacement ---------------------------------------------------------------------------------------------

# Characters whose full case folding is longer than one character but which have a simple folding.
_SIMPLE_FOLD: dict[str, str] = {"ẞ": "ß", "ᾼ": "ᾳ", "ῌ": "ῃ", "ῼ": "ῳ"}
for _base in (0x1F88, 0x1F98, 0x1FA8):
    for _offset in range(8):
        _SIMPLE_FOLD[chr(_base + _offset)] = chr(_base + _offset - 8)


def _fold(ch: str) -> str:
    """Unicode simple case folding, which is what JavaScript's /iu uses."""
    folded = ch.casefold()
    return folded if len(folded) == 1 else _SIMPLE_FOLD.get(ch, ch)


class _Replacer:
    def __init__(self, find: str, replace: str, all_matches: bool, case_sensitive: bool) -> None:
        self.pattern = find if case_sensitive else "".join(_fold(c) for c in find)
        self.replace = replace
        self.fold = not case_sensitive
        self.budget = float("inf") if all_matches else 1
        self.count = 0

    def _find(self, text: str, limit: float) -> list[tuple[int, int]]:
        haystack = "".join(_fold(c) for c in text) if self.fold else text
        out: list[tuple[int, int]] = []
        size = len(self.pattern)
        i = 0
        while i < len(haystack) and len(out) < limit:
            if haystack.startswith(self.pattern, i):
                out.append((i, i + size))
                i += size
            else:
                i += 1
        return out

    def string(self, text: str) -> str:
        if self.budget <= 0:
            return text
        found = self._find(text, self.budget)
        out: list[str] = []
        last = 0
        for start, end in found:
            out.append(text[last:start])
            out.append(self.replace)
            last = end
        out.append(text[last:])
        self.budget -= len(found)
        self.count += len(found)
        return "".join(out)

    def optional(self, text: str | None) -> str | None:
        return None if text is None else self.string(text)

    def runs(self, runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if self.budget <= 0:
            return runs
        full = "".join(run["text"] for run in runs)
        found = self._find(full, self.budget)
        if not found:
            return list(runs)
        self.budget -= len(found)
        self.count += len(found)
        out: list[dict[str, Any]] = []
        offset = 0
        for run in runs:
            run_start, run_end = offset, offset + len(run["text"])
            offset = run_end
            parts: list[str] = []
            cursor = run_start
            for start, end in found:
                if end <= cursor:
                    continue
                if start >= run_end:
                    break
                if start > cursor:
                    parts.append(full[cursor:start])
                    cursor = start
                if start >= run_start:
                    parts.append(self.replace)
                cursor = min(end, run_end)
            parts.append(full[cursor:run_end])
            text = "".join(parts)
            # Runs emptied by the replacement disappear, except citation markers, which carry meaning without text.
            if text or not run["text"] or "citationId" in run:
                out.append({**run, "text": text})
        return out


def _replace_in_content(  # noqa: C901, PLR0912
    content: dict[str, Any], find: str, replace: str, all_matches: bool, case_sensitive: bool
) -> tuple[dict[str, Any], int] | None:
    """The new content and the number of replacements, or None for blocks without text."""
    r = _Replacer(find, replace, all_matches, case_sensitive)
    kind = content["type"]
    nxt = dict(content)
    if kind in ("section", "toggle"):
        nxt["title"] = r.string(content["title"])
    elif kind in ("heading", "code"):
        nxt["text"] = r.string(content["text"])
    elif kind == "paragraph":
        nxt["runs"] = r.runs(content["runs"])
    elif kind == "quote":
        nxt["runs"] = r.runs(content["runs"])
        attribution = r.optional(content.get("attribution"))
        if attribution is not None:
            nxt["attribution"] = attribution
    elif kind == "callout":
        title = r.optional(content.get("title"))
        if title is not None:
            nxt["title"] = title
        nxt["runs"] = r.runs(content["runs"])
    elif kind == "list":
        nxt["items"] = [r.string(item) for item in content["items"]]
    elif kind == "table":
        caption = r.optional(content.get("caption"))
        if caption is not None:
            nxt["caption"] = caption
        nxt["columns"] = [r.string(c) for c in content["columns"]]
        nxt["rows"] = [[r.string(c) for c in row] for row in content["rows"]]
    elif kind == "chart":
        spec = dict(content["spec"])
        # The reference replaces the caption before the title.
        caption = r.optional(spec.get("caption"))
        if caption is not None:
            spec["caption"] = caption
        spec["title"] = r.string(spec["title"])
        nxt["spec"] = spec
    elif kind == "embed":
        nxt["title"] = r.string(content["title"])
    elif kind == "image":
        caption = r.optional(content.get("caption"))
        if caption is not None:
            nxt["caption"] = caption
        nxt["alt"] = r.string(content["alt"])
    elif kind == "metrics":
        items = []
        for entry in content["items"]:
            item = dict(entry)
            item["label"] = r.string(item["label"])
            item["value"] = r.string(item["value"])
            hint = r.optional(item.get("hint"))
            if hint is not None:
                item["hint"] = hint
            items.append(item)
        nxt["items"] = items
    elif kind == "timestamp":
        nxt["label"] = r.string(content["label"])
    else:
        return None
    return nxt, r.count


# --- document drafts ------------------------------------------------------------------------------------------------


class _Draft:
    """A mutable working copy of a document; blocks are kept in pre-order."""

    def __init__(self, document: dict[str, Any]) -> None:
        self.doc = copy.deepcopy(document)
        self.blocks: list[dict[str, Any]] = self.doc.pop("blocks")
        self.citations: list[dict[str, Any]] = self.doc.pop("citations")
        self.retired: list[str] = self.doc.pop("retiredBlockIds")

    def record(self) -> dict[str, Any]:
        return {**self.doc, "blocks": self.blocks, "citations": self.citations, "retiredBlockIds": self.retired}

    def index_of(self, block_id: str) -> int:
        for i, b in enumerate(self.blocks):
            if b["id"] == block_id:
                return i
        return -1

    def find(self, block_id: str) -> dict[str, Any] | None:
        i = self.index_of(block_id)
        return self.blocks[i] if i >= 0 else None

    def subtree_end(self, index: int) -> int:
        """Index just past a block's contiguous descendants (documents are normally kept in pre-order)."""
        members = {self.blocks[index]["id"]}
        end = index + 1
        while (
            end < len(self.blocks)
            and self.blocks[end]["parentId"] is not None
            and self.blocks[end]["parentId"] in members
        ):
            members.add(self.blocks[end]["id"])
            end += 1
        return end

    def subtree_ids(self, roots: list[str]) -> set[str]:
        found = set(roots)
        children: dict[str, list[str]] = {}
        for b in self.blocks:
            if b["parentId"] is not None:
                children.setdefault(b["parentId"], []).append(b["id"])
        queue = list(roots)
        for item in queue:
            for child in children.get(item, []):
                if child not in found:
                    found.add(child)
                    queue.append(child)
        return found

    def parent_exists(self, parent_id: str | None) -> None:
        if parent_id is None:
            return
        found = self.find(parent_id)
        if found is None or found["content"]["type"] not in ("section", "toggle"):
            hint = (
                f'Block "{parent_id}" is a {found["content"]["type"]}; '
                "only section and toggle blocks can contain other blocks."
                if found
                else f'No block "{parent_id}" exists. Insert the section or toggle first '
                "(earlier in the same batch is fine) or use parentId: null."
            )
            _reject("validation", "Parent must reference an existing section or toggle.", parent_id, hint)

    def put(self, block: dict[str, Any], after_id: Any) -> None:
        """Place a block among its siblings: after the subtree of its predecessor, or right after its parent."""
        parent = block["parentId"]
        self.parent_exists(parent)
        if after_id is not _UNSET and after_id is not None and after_id == block["id"]:
            _reject("validation", "A block cannot anchor itself.", block["id"])

        def first_child() -> int:
            return len(self.blocks) if parent is None else self.index_of(parent) + 1

        if after_id is None:
            first = next((i for i, b in enumerate(self.blocks) if b["parentId"] == parent), -1)
            position = first if first != -1 else first_child()
        elif after_id is not _UNSET:
            anchor = self.index_of(after_id)
            if anchor == -1 or self.blocks[anchor]["parentId"] != parent:
                where = "the document root" if parent is None else f'"{parent}"'
                _reject(
                    "validation",
                    "Ordering anchor must reference a sibling in the destination section.",
                    block["id"],
                    f'afterId "{after_id}" must be a direct child of {where}. '
                    "Omit afterId to append, or use null to prepend.",
                )
            position = self.subtree_end(anchor)
        else:
            last = next((i for i in range(len(self.blocks) - 1, -1, -1) if self.blocks[i]["parentId"] == parent), -1)
            position = self.subtree_end(last) if last != -1 else first_child()
        self.blocks.insert(position, block)

    def relocate(self, block: dict[str, Any], parent_id: str | None, after_id: Any) -> None:
        """Detach a block with its contiguous descendants, then reinsert the run at the new position."""
        index = self.index_of(block["id"])
        end = self.subtree_end(index)
        run = self.blocks[index:end]
        del self.blocks[index:end]
        block["parentId"] = parent_id
        self.put(block, after_id)
        at = self.index_of(block["id"]) + 1
        self.blocks[at:at] = run[1:]

    def remove(self, ids: set[str], high_water: dict[str, int], at: str) -> None:
        retired = set(self.retired)
        for b in self.blocks:
            if b["id"] in ids:
                _tick(b, high_water, at)
                if b["id"] not in retired:
                    retired.add(b["id"])
                    self.retired.append(b["id"])
        self.blocks = [b for b in self.blocks if b["id"] not in ids]

    def block_at(self, block_id: str, expected: int) -> dict[str, Any]:
        b = self.find(block_id)
        if b is None:
            _reject(
                "not-found",
                "Block does not exist.",
                block_id,
                "Read the document to list current block IDs. Deleted IDs no longer exist.",
            )
        if b["version"] != expected:
            _reject(
                "conflict",
                "Block changed; re-read before proposing another edit.",
                block_id,
                f'Block "{block_id}" is now at version {b["version"]} (you sent {expected}). '
                f"Re-read it and retry with expectedVersion {b['version']} if your edit still applies.",
            )
        return b


def _tick(b: dict[str, Any], high_water: dict[str, int], at: str) -> None:
    b["version"] = _increment(max(b["version"], high_water.get(b["id"], 0)), f"Block {b['id']}")
    b["updatedAt"] = at
    high_water[b["id"]] = b["version"]


def _anchor(op: dict[str, Any]) -> Any:
    return op.get("afterId", _UNSET)


def _new_block(source: dict[str, Any], at: str) -> dict[str, Any]:
    return {**copy.deepcopy(source), "version": 1, "createdAt": at, "updatedAt": at}


def _apply_operation(  # noqa: C901, PLR0912, PLR0915
    d: _Draft, op: dict[str, Any], high_water: dict[str, int], at: str, pending: set[str]
) -> None:
    kind = op["type"]
    if kind == "insertBlock":
        source = op["block"]
        if source["id"] in pending or d.find(source["id"]):
            _reject("duplicate", "Block ID is already used or reserved.", source["id"], _REUSE_HINT)
        block = _new_block(source, at)
        d.put(block, _anchor(op))
        high_water[block["id"]] = 1
        pending.add(block["id"])
    elif kind == "updateBlock":
        block = d.block_at(op["blockId"], op["expectedVersion"])
        block["content"] = copy.deepcopy(op["content"])
        if "citationIds" in op:
            block["citationIds"] = list(op["citationIds"])
        _tick(block, high_water, at)
    elif kind == "moveBlock":
        block = d.block_at(op["blockId"], op["expectedVersion"])
        # Validate the destination before detaching; cycles are validated against the final atomic document.
        d.parent_exists(op["parentId"])
        if op["parentId"] is not None and op["parentId"] in d.subtree_ids([block["id"]]):
            _reject(
                "validation",
                "A block cannot be moved into itself or its own descendant.",
                block["id"],
                "Choose a destination outside the moved subtree.",
            )
        d.relocate(block, op["parentId"], _anchor(op))
        _tick(block, high_water, at)
    elif kind == "deleteBlock":
        d.block_at(op["blockId"], op["expectedVersion"])
        d.remove(d.subtree_ids([op["blockId"]]), high_water, at)
    elif kind == "setTitle":
        d.doc["title"] = op["title"]
    elif kind == "setFormat":
        d.doc["format"] = copy.deepcopy(op["format"])
    elif kind == "addCitation":
        if any(c["id"] == op["citation"]["id"] for c in d.citations):
            _reject(
                "duplicate",
                "Citation ID already exists.",
                None,
                "Use updateCitation to change an existing citation, or choose a new ID.",
            )
        d.citations.append(copy.deepcopy(op["citation"]))
    elif kind == "insertBlocks":
        # The first block follows afterId; each later block follows the previous block with the same parent.
        last: dict[str | None, str] = {}
        for i, source in enumerate(op["blocks"]):
            if source["id"] in pending:
                _reject("duplicate", "Block ID is already used or reserved.", source["id"], _REUSE_HINT)
            block = _new_block(source, at)
            anchor = _anchor(op) if i == 0 else last.get(source["parentId"], _UNSET)
            d.put(block, anchor)
            high_water[block["id"]] = 1
            pending.add(block["id"])
            last[source["parentId"]] = source["id"]
    elif kind == "duplicateBlock":
        _duplicate(d, op, at, high_water, pending)
    elif kind == "replaceText":
        block = d.block_at(op["blockId"], op["expectedVersion"])
        replaced = _replace_in_content(
            block["content"], op["find"], op["replace"], bool(op.get("all")), bool(op.get("caseSensitive"))
        )
        if replaced is None:
            _reject(
                "validation",
                f"A {block['content']['type']} block has no text to replace.",
                block["id"],
                "Use updateBlock to change this block.",
            )
        content, count = replaced
        if count == 0:
            matching = "is" if op.get("caseSensitive") else "is not"
            _reject(
                "not-found",
                "The text to replace was not found in the block.",
                block["id"],
                f"Matching {matching} case-sensitive. Read the block and copy the exact wording; "
                "a match cannot span separate list items or table cells.",
            )
        block["content"] = content
        _tick(block, high_water, at)
    elif kind == "deleteBlocks":
        for ref in op["blocks"]:
            d.block_at(ref["blockId"], ref["expectedVersion"])
        d.remove(d.subtree_ids([ref["blockId"] for ref in op["blocks"]]), high_water, at)
    elif kind == "moveBlocks":
        moving = {ref["blockId"] for ref in op["blocks"]}
        blocks = [d.block_at(ref["blockId"], ref["expectedVersion"]) for ref in op["blocks"]]
        anchor = _anchor(op)
        if anchor is not _UNSET and anchor is not None and anchor in moving:
            _reject(
                "validation",
                "afterId cannot be one of the moved blocks.",
                anchor,
                "Anchor on a block that stays in place, or omit afterId.",
            )
        d.parent_exists(op["parentId"])
        if op["parentId"] is not None and op["parentId"] in d.subtree_ids(list(moving)):
            _reject(
                "validation",
                "A block cannot be moved into itself or its own descendant.",
                op["parentId"],
                "Choose a destination outside the moved subtrees.",
            )
        # Blocks land in the given order: the first after afterId, each later one after its predecessor.
        for i, block in enumerate(blocks):
            d.relocate(block, op["parentId"], anchor if i == 0 else blocks[i - 1]["id"])
            _tick(block, high_water, at)
    elif kind == "updateCitation":
        for i, existing in enumerate(d.citations):
            if existing["id"] == op["citation"]["id"]:
                d.citations[i] = copy.deepcopy(op["citation"])
                return
        _reject(
            "not-found",
            "Citation does not exist.",
            None,
            f'No citation "{op["citation"]["id"]}". Use addCitation to create it.',
        )
    elif kind == "removeCitation":
        _remove_citation(d, op["citationId"], high_water, at)


def _remove_citation(d: _Draft, citation_id: str, high_water: dict[str, int], at: str) -> None:
    index = next((i for i, c in enumerate(d.citations) if c["id"] == citation_id), -1)
    if index == -1:
        _reject(
            "not-found",
            "Citation does not exist.",
            None,
            f'No citation "{citation_id}". Read the document to list citation IDs.',
        )
    del d.citations[index]
    # References are stripped, never left dangling: block-level IDs, inline markers, and marker-only runs.
    for b in d.blocks:
        changed = False
        if citation_id in b["citationIds"]:
            b["citationIds"] = [entry for entry in b["citationIds"] if entry != citation_id]
            changed = True
        content = b["content"]
        if content["type"] in ("paragraph", "quote", "callout"):
            runs = content["runs"]
            if any(run.get("citationId") == citation_id for run in runs):
                kept = [run for run in runs if run.get("citationId") != citation_id or run["text"] != ""]
                for run in kept:
                    if run.get("citationId") == citation_id:
                        del run["citationId"]
                content["runs"] = kept
                changed = True
        if changed:
            _tick(b, high_water, at)


def _duplicate(d: _Draft, op: dict[str, Any], at: str, high_water: dict[str, int], pending: set[str]) -> None:
    original = d.block_at(op["blockId"], op["expectedVersion"])
    children: dict[str, list[dict[str, Any]]] = {}
    for b in d.blocks:
        if b["parentId"] is not None:
            children.setdefault(b["parentId"], []).append(b)
    order = [original]

    def walk(parent: str) -> None:
        for child in children.get(parent, []):
            order.append(child)
            walk(child["id"])

    walk(original["id"])
    new_ids: dict[str, str] = op["newIds"]
    needed = [b["id"] for b in order]
    needed_set = set(needed)
    missing = [i for i in needed if i not in new_ids]
    unexpected = [i for i in new_ids if i not in needed_set]
    if missing or unexpected:
        hint = (
            (f"Missing: {', '.join(missing)}. " if missing else "")
            + (f"Not part of this subtree: {', '.join(unexpected)}. " if unexpected else "")
            + f"Required old IDs: {', '.join(needed)}."
        )
        _reject(
            "validation",
            f"newIds must map exactly the duplicated block and its {len(needed) - 1} descendant(s).",
            original["id"],
            hint,
        )
    for old in needed:
        if new_ids[old] in pending:
            _reject(
                "duplicate",
                "Block ID is already used or reserved.",
                new_ids[old],
                "Choose a fresh ID for each copy. IDs of deleted blocks stay reserved.",
            )
    for i, source in enumerate(order):
        copied = {
            **copy.deepcopy(source),
            "id": new_ids[source["id"]],
            "parentId": source["parentId"] if i == 0 else new_ids[source["parentId"]],
            "version": 1,
            "createdAt": at,
            "updatedAt": at,
        }
        anchor = _UNSET
        if i == 0:
            anchor = op["afterId"] if "afterId" in op else original["id"]
        d.put(copied, anchor)
        high_water[copied["id"]] = 1
        pending.add(copied["id"])


# --- the editor -----------------------------------------------------------------------------------------------------


def _now_iso() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _predecessors(document: dict[str, Any]) -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    previous: dict[str | None, str] = {}
    for b in document["blocks"]:
        out[b["id"]] = previous.get(b["parentId"])
        previous[b["parentId"]] = b["id"]
    return out


def _block_state(b: dict[str, Any]) -> str:
    return json.dumps(
        {"parentId": b["parentId"], "content": b["content"], "citationIds": b["citationIds"]}, sort_keys=True
    )


class Editor:
    """One document session. Safe for concurrent use; commits are serialized."""

    def __init__(
        self,
        document: dict[str, Any],
        now: Callable[[], str] | None = None,
        history_limit: int | None = None,
    ) -> None:
        validated = validate_document(document)
        if not validated["ok"]:
            issue = validated["issues"][0]
            raise ValueError(f"invalid document: {issue['message']} ({issue.get('path', '')})")
        limit = 100 if history_limit is None else history_limit
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 0 or limit > 1000:
            raise ValueError("historyLimit must be an integer between 0 and 1,000.")
        self._now = now or _now_iso
        self._limit = limit
        self._lock = threading.RLock()
        self._snapshot: dict[str, Any] = validated["value"]
        self._versions = {b["id"]: b["version"] for b in self._snapshot["blocks"]}
        self._reserved = set(self._snapshot["retiredBlockIds"]) | {b["id"] for b in self._snapshot["blocks"]}
        self._seen: set[str] = set()
        self._undo: list[tuple[dict[str, Any], dict[str, Any]]] = []
        self._redo: list[tuple[dict[str, Any], dict[str, Any]]] = []
        self._revisions: list[dict[str, Any]] = []
        self._last: tuple[str, str, dict[str, Any], dict[str, Any]] | None = None

    @property
    def snapshot(self) -> dict[str, Any]:
        """The current document. Callers must not modify it."""
        return self._snapshot

    @property
    def revisions(self) -> list[dict[str, Any]]:
        """The revision log (the most recent max(1, history_limit) entries)."""
        return list(self._revisions)

    # -- internals ------------------------------------------------------------------------------------------------

    def _failure(self, issues: list[dict[str, Any]]) -> dict[str, Any]:
        return {"ok": False, "issues": with_hints(issues), "currentRevision": self._snapshot["revision"]}

    def _clock(self) -> str:
        try:
            at = timestamp(self._now(), "options.now")
        except Invalid:
            _reject("validation", "Clock must return a valid ISO UTC timestamp.")
        if timestamp_millis(at) < timestamp_millis(self._snapshot["updatedAt"]):
            _reject("validation", "Clock cannot move backward relative to the current document.")
        return at

    def _commit(self, nxt: dict[str, Any], revision: dict[str, Any], versions: dict[str, int]) -> None:
        self._snapshot = nxt
        self._versions = versions
        self._reserved.update(b["id"] for b in nxt["blocks"])
        self._reserved.update(nxt["retiredBlockIds"])
        self._revisions.append(revision)
        self._revisions = self._revisions[-max(1, self._limit) :]

    def _guard(self, fallback: str, step: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        try:
            return step()
        except _Rejected as rejected:
            return self._failure([rejected.issue])
        except Exception:  # noqa: BLE001 - an unexpected failure must never leave a half-applied commit visible
            return self._failure([{"code": "validation", "message": fallback}])

    def _limit_stack(self, stack: list[Any]) -> list[Any]:
        return stack[-self._limit :] if self._limit > 0 else stack

    # -- apply ------------------------------------------------------------------------------------------------------

    def apply(self, value: Any) -> dict[str, Any]:  # noqa: C901
        """Validate and apply one transaction atomically."""
        with self._lock:
            result = validate_transaction(value)
            if not result["ok"]:
                return self._failure(result["issues"])
            tx = result["value"]
            fingerprint = json.dumps(tx, sort_keys=True)
            if tx["id"] in self._seen:
                if self._last and self._last[0] == tx["id"] and self._last[1] == fingerprint:
                    return {"ok": True, "document": self._last[2], "revision": self._last[3], "duplicate": True}
                return self._failure(
                    [
                        {
                            "code": "duplicate",
                            "message": "Transaction ID is consumed. Only an identical retry of the immediately "
                            "preceding successful transaction is allowed.",
                        }
                    ]
                )
            if len(self._seen) >= 100_000:
                return self._failure(
                    [
                        {
                            "code": "history",
                            "message": "Session transaction limit reached. "
                            "Persist and reload the document to start a new session.",
                        }
                    ]
                )
            return self._guard("Transaction could not be applied safely.", lambda: self._apply(tx, fingerprint))

    def _apply(self, tx: dict[str, Any], fingerprint: str) -> dict[str, Any]:
        snapshot = self._snapshot
        stale = tx["baseRevision"] != snapshot["revision"]
        if stale:
            rebasable = tx.get("conflictPolicy") == "rebase-safe" and all(
                o["type"] in ("updateBlock", "replaceText") for o in tx["operations"]
            )
            if tx["baseRevision"] > snapshot["revision"] or not rebasable:
                hint = (
                    f"baseRevision {tx['baseRevision']} is ahead of the document (revision {snapshot['revision']})."
                    if tx["baseRevision"] > snapshot["revision"]
                    else f"The document is at revision {snapshot['revision']} (you sent {tx['baseRevision']}). "
                    f"Re-read it and retry with baseRevision {snapshot['revision']}. "
                    'conflictPolicy "rebase-safe" only carries version-guarded updateBlock and replaceText '
                    "operations over a stale revision."
                )
                _reject("conflict", "Document changed; re-read before proposing another edit.", None, hint)
            for o in tx["operations"]:
                if o["type"] != "updateBlock":
                    continue
                existing = next((b for b in snapshot["blocks"] if b["id"] == o["blockId"]), None)
                if existing is None or existing["content"]["type"] != o["content"]["type"]:
                    _reject(
                        "conflict",
                        "Rebased updates must preserve the block content type.",
                        o["blockId"],
                        "Re-read the block and propose the change against the current document revision.",
                    )
        at = self._clock()
        draft = _Draft(snapshot)
        high_water = dict(self._versions)
        pending = set(self._reserved)
        for o in tx["operations"]:
            _apply_operation(draft, o, high_water, at, pending)
        record = draft.record()
        record["revision"] = _increment(snapshot["revision"], "Document")
        record["updatedAt"] = at
        final = validate_document(record)
        if not final["ok"]:
            return self._failure(final["issues"])
        revision: dict[str, Any] = {
            "number": record["revision"],
            "transactionId": tx["id"],
            "actor": copy.deepcopy(tx["actor"]),
            "at": at,
            "kind": "apply",
            "operations": copy.deepcopy(tx["operations"]),
        }
        if stale:
            revision["rebasedFrom"] = tx["baseRevision"]
        before = snapshot
        self._commit(final["value"], revision, high_water)
        if self._limit > 0:
            self._undo = self._limit_stack([*self._undo, (before, self._snapshot)])
        self._redo = []
        self._seen.add(tx["id"])
        self._last = (tx["id"], fingerprint, self._snapshot, revision)
        return {"ok": True, "document": self._snapshot, "revision": revision}

    # -- history ----------------------------------------------------------------------------------------------------

    def undo(self, actor: Any, expected_revision: Any) -> dict[str, Any]:
        """Restore the document before the last applied transaction, as a new revision."""
        return self._history("undo", actor, expected_revision)

    def redo(self, actor: Any, expected_revision: Any) -> dict[str, Any]:
        """Re-apply the last undone transaction, as a new revision."""
        return self._history("redo", actor, expected_revision)

    def _history(self, kind: str, actor: Any, expected_revision: Any) -> dict[str, Any]:
        with self._lock:
            request = validate_history_request(actor, expected_revision)
            if not request["ok"]:
                return self._failure(request["issues"])
            if request["value"]["expectedRevision"] != self._snapshot["revision"]:
                return self._failure(
                    [{"code": "conflict", "message": "Document changed; re-read before using history."}]
                )
            stack = self._undo if kind == "undo" else self._redo
            if not stack:
                return self._failure([{"code": "history", "message": f"No {kind} history is available."}])
            entry = stack[-1]
            return self._guard(
                "History could not be restored safely.", lambda: self._restore(kind, entry, request["value"]["actor"])
            )

    def _restore(
        self, kind: str, entry: tuple[dict[str, Any], dict[str, Any]], actor: dict[str, Any]
    ) -> dict[str, Any]:
        snapshot = self._snapshot
        at = self._clock()
        target = copy.deepcopy(entry[0] if kind == "undo" else entry[1])
        high_water = dict(self._versions)
        current_by_id = {b["id"]: b for b in snapshot["blocks"]}
        target_ids = {b["id"] for b in target["blocks"]}
        retired: dict[str, None] = dict.fromkeys([*snapshot["retiredBlockIds"], *target["retiredBlockIds"]])
        current_pred, target_pred = _predecessors(snapshot), _predecessors(target)
        for current in snapshot["blocks"]:
            if current["id"] not in target_ids:
                high_water[current["id"]] = _increment(
                    high_water.get(current["id"], current["version"]), f"Block {current['id']}"
                )
                retired[current["id"]] = None
        # History never copies old versions back: all restored blocks receive their current high-water version.
        for block in target["blocks"]:
            current = current_by_id.get(block["id"])
            if (
                current is None
                or _block_state(current) != _block_state(block)
                or current_pred[block["id"]] != target_pred[block["id"]]
            ):
                _tick(block, high_water, at)
            else:
                block["version"] = current["version"]
                block["updatedAt"] = current["updatedAt"]
        target["retiredBlockIds"] = list(retired)
        target["revision"] = _increment(snapshot["revision"], "Document")
        target["updatedAt"] = at
        final = validate_document(target)
        if not final["ok"]:
            return self._failure(final["issues"])
        revision: dict[str, Any] = {
            "number": target["revision"],
            "transactionId": f"history:{kind}:{target['revision']}",
            "actor": copy.deepcopy(actor),
            "at": at,
            "kind": kind,
            "operations": [],
        }
        self._commit(final["value"], revision, high_water)
        if kind == "undo":
            self._undo = self._undo[:-1]
            self._redo = self._limit_stack([*self._redo, entry])
        else:
            self._redo = self._redo[:-1]
            self._undo = self._limit_stack([*self._undo, entry])
        self._last = None
        return {"ok": True, "document": self._snapshot, "revision": revision}

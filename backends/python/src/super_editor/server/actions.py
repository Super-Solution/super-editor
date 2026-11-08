# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""The Super Editor actions over a session: validated input, one Core transaction per write, compact results."""

from __future__ import annotations

import re
import secrets
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta, timezone
from typing import Any

from .._common import js_number, line
from ..documents import diff_documents, summarize_revision
from ..editor import Editor, with_hints
from ..export import to_markdown
from ..html_export import to_html
from ..inline import JS_SPACE, js_trim, parse_inline
from ..markdown_import import from_markdown
from ..query import block_text, child_index, descendants_of, find_blocks, get_outline
from ..text import document_stats, to_plain_text
from ..validation import js_length, timestamp_millis, validate_transaction
from .check import ActionIssue, check, plain_copy, reject
from .service import EditorService, Service, revision_of
from .spec import Action, limit, spec
from .templates import clean_subject, collapse_space, create_template, is_template_kind, template_title

Record = dict[str, Any]
_ABSENT: Any = object()

BLOCK_TYPES = (
    "section", "heading", "paragraph", "list", "table", "chart", "embed", "timestamp", "quote", "callout", "code",
    "divider", "image", "toggle", "metrics", "toc", "pageBreak",
)  # fmt: skip


def _iso_ms(ms: int) -> str:
    moment = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=ms)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def current_iso() -> str:
    return _iso_ms(_now_ms())


class Context:
    """What an action needs besides its input: the actor recorded on revisions and the clock for created timestamps."""

    def __init__(self, actor: Mapping[str, Any] | None = None, now: Callable[[], str] | None = None) -> None:
        self.actor: dict[str, Any] = dict(actor) if actor else {"id": "agent", "kind": "agent"}
        self.now: Callable[[], str] = now or current_iso


class _Ctx:
    def __init__(self, service: Service, context: Context, inp: Record, name: str) -> None:
        self.service = service
        self.actor = context.actor
        self.now = context.now
        self.inp = inp
        self.doc = service.read()
        self.name = name

    def has(self, key: str) -> bool:
        return key in self.inp

    def get_str(self, key: str) -> str | None:
        v = self.inp.get(key)
        return v if isinstance(v, str) else None

    def str_or(self, key: str) -> str:
        return self.get_str(key) or ""

    def get_num(self, key: str) -> int | float | None:
        v = self.inp.get(key)
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None

    def get_bool(self, key: str) -> bool | None:
        v = self.inp.get(key)
        return v if isinstance(v, bool) else None

    def get_list(self, key: str) -> list[Any] | None:
        v = self.inp.get(key)
        return v if isinstance(v, list) else None

    def nullable(self, key: str) -> Any:
        """`has(key) ? input[key] : <absent>`: a string, None or _ABSENT."""
        return self.inp.get(key, _ABSENT)

    def transaction_id(self) -> str:
        return self.get_str("transactionId") or f"{self.name}-{secrets.token_hex(8)}"


def _blocks(doc: Mapping[str, Any]) -> list[Record]:
    return list(doc.get("blocks") or [])


def _content(block: Record) -> Record:
    return block["content"]  # type: ignore[no-any-return]


def _need(doc: Mapping[str, Any], block_id: str, label: str) -> Record:
    for block in _blocks(doc):
        if block["id"] == block_id:
            return block
    reject(
        "not-found",
        f'{label} "{block_id}" does not exist.',
        "Use get_outline or find_blocks to list current block IDs. Deleted IDs no longer exist.",
        blockId=block_id,
    )


def _utf16_prefix(text: str, n: int) -> str:
    """The longest prefix of at most n UTF-16 code units that does not split a surrogate pair."""
    units = 0
    for i, ch in enumerate(text):
        width = 2 if ord(ch) >= 0x10000 else 1
        if units + width > n:
            return text[:i]
        units += width
    return text


def _preview(value: str) -> str:
    flat = js_trim(collapse_space(value))
    cap = limit("textPreviewChars")
    if js_length(flat) > cap:
        return _utf16_prefix(flat, cap - 1) + "…"
    return flat


def _child_counts(doc: Mapping[str, Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for block in _blocks(doc):
        parent = block.get("parentId")
        if isinstance(parent, str):
            counts[parent] = counts.get(parent, 0) + 1
    return counts


def _brief(block: Record, counts: dict[str, int]) -> Record:
    out: Record = {
        "id": block["id"],
        "type": _content(block)["type"],
        "version": block["version"],
        "parentId": block["parentId"],
        "text": _preview(block_text(block)),
    }
    if block.get("citationIds"):
        out["citationIds"] = block["citationIds"]
    if counts.get(block["id"], 0) > 0:
        out["children"] = counts[block["id"]]
    return out


def failure(service: Service, issues: list[dict[str, Any]]) -> Record:
    return {"ok": False, "issues": with_hints(issues), "currentRevision": revision_of(service)}


_OPERATION_PATH = re.compile(r"^transaction\.operations\[\d+\]")


def _commit(  # noqa: C901, PLR0912, PLR0915
    c: _Ctx,
    operations: list[Any],
    *,
    path: Callable[[str], str] | None = None,
    extra: Record | None = None,
    verb: str = "added",
) -> Record:
    """Build one Core transaction from operations, apply it and report a compact result."""
    before = c.doc
    base = before["revision"]
    expected = c.get_num("expectedRevision")
    if expected is not None:
        base = expected
    tx: Record = {"id": c.transaction_id(), "actor": c.actor, "baseRevision": base, "operations": operations}
    if c.inp.get("conflictPolicy") == "rebase-safe":
        tx["conflictPolicy"] = "rebase-safe"
    result = c.service.apply(tx)
    if not result["ok"]:
        issues = []
        for issue in result["issues"]:
            issue = dict(issue)
            if issue.get("path"):
                mapped = _OPERATION_PATH.sub("input", issue["path"])
                issue["path"] = path(mapped) if path else mapped
            issues.append(issue)
        return {"ok": False, "issues": with_hints(issues), "currentRevision": result["currentRevision"]}
    after = result["document"]
    if result.get("duplicate"):
        out: Record = {
            "ok": True,
            "revision": after["revision"],
            "summary": "Already applied (same transactionId); nothing changed.",
            "added": [],
            "removed": [],
            "changed": [],
            "moved": [],
            "blocks": [],
            "duplicate": True,
        }
        out.update(extra or {})
        return out
    diff = diff_documents(before, after)
    touched = {*diff["added"], *diff["changed"], *diff["moved"]}
    blocks = [
        {"id": b["id"], "type": _content(b)["type"], "version": b["version"]}
        for b in _blocks(after)
        if b["id"] in touched
    ]
    parts: list[str] = []
    if diff["added"]:
        parts.append(f"{verb} {len(diff['added'])} block(s)")
    if diff["changed"]:
        parts.append(f"changed {len(diff['changed'])}")
    if diff["moved"]:
        parts.append(f"moved {len(diff['moved'])}")
    if diff["removed"]:
        parts.append(f"removed {len(diff['removed'])}")
    if diff["titleChanged"]:
        parts.append("renamed the document")
    cites = diff["citations"]
    if cites["added"]:
        parts.append(f"added {len(cites['added'])} citation(s)")
    if cites["removed"]:
        parts.append(f"removed {len(cites['removed'])} citation(s)")
    out = {
        "ok": True,
        "revision": after["revision"],
        "summary": (", ".join(parts) + ".") if parts else "Document metadata updated.",
        "added": list(diff["added"]),
        "removed": list(diff["removed"]),
        "changed": list(diff["changed"]),
        "moved": list(diff["moved"]),
    }
    if diff["titleChanged"]:
        out["titleChanged"] = True
    if cites["added"] or cites["removed"] or cites["changed"]:
        out["citations"] = {
            "added": list(cites["added"]),
            "removed": list(cites["removed"]),
            "changed": list(cites["changed"]),
        }
    if len(blocks) > limit("resultBlocks"):
        out["blocks"] = blocks[: limit("resultBlocks")]
        out["truncated"] = True
    else:
        out["blocks"] = blocks
    out.update(extra or {})
    return out


def _insert_operations(blocks: list[Record], after_id: Any) -> list[Any]:
    operations: list[Any] = []
    last_by_parent: dict[Any, str] = {}
    per = limit("blocksPerCall")
    for start in range(0, len(blocks), per):
        chunk = blocks[start : start + per]
        op: Record = {"type": "insertBlocks", "blocks": chunk}
        if start == 0:
            if after_id is not _ABSENT:
                op["afterId"] = after_id
        elif chunk[0]["parentId"] in last_by_parent:
            op["afterId"] = last_by_parent[chunk[0]["parentId"]]
        operations.append(op)
        for block in chunk:
            last_by_parent[block["parentId"]] = block["id"]
    return operations


def _normalize_block(entry: Record) -> Record:
    return {
        "id": entry.get("id"),
        "parentId": entry.get("parentId"),
        "content": entry.get("content"),
        "citationIds": entry.get("citationIds") or [],
    }


def _reserved_ids(doc: Mapping[str, Any]) -> set[str]:
    return {*(doc.get("retiredBlockIds") or []), *(b["id"] for b in _blocks(doc))}


def _create_block_id(prefix: str, taken: set[str]) -> str:
    i = 1
    while True:
        candidate = f"{prefix}-{i}"
        if candidate not in taken:
            taken.add(candidate)
            return candidate
        i += 1


def _markdown_blocks(c: _Ctx, markdown: str, parent_id: Any, id_prefix: str | None) -> list[Record]:
    n = js_length(markdown)
    if n > limit("markdownChars"):
        reject(
            "validation",
            f"Markdown is {n} characters; the limit is {limit('markdownChars')}.",
            "Split it into several calls.",
            path="input.markdown",
        )
    reserved = _reserved_ids(c.doc)
    parent = parent_id if isinstance(parent_id, str) else None
    revision = c.doc["revision"]
    for attempt in range(50):
        prefix = id_prefix
        if prefix is None:
            prefix = "i" + js_number(revision + 1) + (f"x{attempt}" if attempt > 0 else "")
        blocks = from_markdown(markdown, id_prefix=prefix, parent_id=parent)
        if not blocks:
            reject(
                "validation",
                "The markdown contains no blocks.",
                "Provide at least one paragraph, heading, list or table.",
                path="input.markdown",
            )
        clash = next((b["id"] for b in blocks if b["id"] in reserved), "")
        if not clash:
            return list(blocks)
        if id_prefix is not None:
            reject(
                "duplicate",
                f'Block ID "{clash}" is already used or reserved.',
                "Choose a different idPrefix, or omit it to get a fresh one.",
                path="input.idPrefix",
                blockId=clash,
            )
    reject(
        "duplicate",
        "Could not find a free ID prefix for the imported blocks.",
        "Pass an explicit idPrefix.",
        path="input.idPrefix",
    )


_GENERATED_BLOCK = re.compile(r"\.blocks\[(\d+)\].*$")


def _generated_path(blocks: list[Record]) -> Callable[[str], str]:
    def rewrite(path: str) -> str:
        def one(match: re.Match[str]) -> str:
            index = match.group(1)
            block_id = blocks[int(index)]["id"] if int(index) < len(blocks) else index
            return f'.markdown (generated block "{block_id}")'

        return _GENERATED_BLOCK.sub(one, path)

    return rewrite


def _inline_runs(value: str, plain: bool) -> list[Any]:
    if value == "":
        return []
    if plain:
        return [{"text": value}]
    return list(parse_inline(value))


def _list_item(text: str) -> str:
    """Strip a leading bullet, number and task checkbox from one line of a list rewrite."""
    n = len(text)
    i = 0
    while i < n and text[i] in JS_SPACE:
        i += 1
    j = i
    if j < n and text[j] in "-*+":
        j += 1
    elif j < n and "0" <= text[j] <= "9":
        while j < n and "0" <= text[j] <= "9":
            j += 1
        if j >= n or text[j] not in ".)":
            return js_trim(text)
        j += 1
    else:
        return js_trim(text)
    k = j
    while k < n and text[k] in JS_SPACE:
        k += 1
    if k == j:
        return js_trim(text)
    if k + 2 < n and text[k] == "[" and text[k + 1] in " xX" and text[k + 2] == "]":
        m = k + 3
        while m < n and text[m] in JS_SPACE:
            m += 1
        if m > k + 3:
            k = m
    return js_trim(text[k:])


def _rewrite_text(block: Record, value: str, plain: bool) -> Record:  # noqa: C901
    content = _content(block)
    kind = content["type"]
    if kind == "paragraph":
        return {"type": "paragraph", "runs": _inline_runs(value, plain)}
    if kind in ("quote", "callout"):
        return {**content, "runs": _inline_runs(value, plain)}
    if kind == "heading":
        return {**content, "text": line(value)}
    if kind == "code":
        return {**content, "text": value}
    if kind in ("section", "toggle"):
        return {**content, "title": line(value)}
    if kind == "list":
        items = [item for item in (_list_item(entry) for entry in value.split("\n")) if item != ""]
        if not items:
            reject(
                "validation",
                "A list needs at least one non-empty line.",
                "Use delete_blocks to remove the list.",
                path="input.text",
                blockId=block["id"],
            )
        out = {**content, "items": items}
        if isinstance(content.get("checked"), list):
            checked = content["checked"]
            out["checked"] = [checked[i] if i < len(checked) else False for i in range(len(items))]
        if isinstance(content.get("indent"), list):
            indent = content["indent"]
            out["indent"] = [indent[i] if i < len(indent) else 0 for i in range(len(items))]
        return out
    reject(
        "validation",
        f"A {kind} block has no single text to replace.",
        "update_block_text edits paragraph, heading, quote, callout, code, list, section and toggle blocks. Use "
        "replace_text to change a phrase (it also reaches captions, titles and table cells) or update_block to send "
        "the full content.",
        path="input.blockId",
        blockId=block["id"],
    )


def _has_text(block: Record, find: str, case_sensitive: bool) -> bool:
    body = block_text(block)
    return find in body if case_sensitive else find.lower() in body.lower()


def _scratch_service(doc: Mapping[str, Any]) -> Service:
    """A throwaway editor for previews. Its clock never runs behind the document."""
    floor = timestamp_millis(doc["updatedAt"])
    return EditorService(Editor(dict(doc), now=lambda: _iso_ms(max(_now_ms(), floor))))


def _sub_document(doc: Record, block_id: str | None) -> Record:
    if block_id is None:
        return doc
    root = {**_need(doc, block_id, "Block"), "parentId": None}
    return {**doc, "blocks": [root, *descendants_of(doc, block_id)]}


Handler = Callable[[_Ctx], Record]


def _export(format_name: str, render: Callable[[Record, bool, bool], str]) -> Handler:
    def handler(c: _Ctx) -> Record:
        block_id = c.get_str("blockId")
        standalone = bool(c.get_bool("standalone"))
        body = render(_sub_document(c.doc, block_id), block_id is None, standalone)
        return {
            "ok": True,
            "revision": c.doc["revision"],
            "format": format_name,
            "characters": js_length(body),
            "text": body,
        }

    return handler


def _int_input(c: _Ctx, key: str, fallback: int) -> int:
    value = c.get_num(key)
    return int(value) if value is not None else fallback


def _get_outline(c: _Ctx) -> Record:
    max_depth = c.get_num("maxDepth")

    def trim(nodes: list[Record], depth: int) -> list[Record]:
        out = []
        for n in nodes:
            node = {"id": n["id"], "type": n["type"], "title": n["title"], "level": n["level"]}
            node["children"] = [] if max_depth is not None and depth >= max_depth else trim(n["children"], depth + 1)
            out.append(node)
        return out

    return {
        "ok": True,
        "revision": c.doc["revision"],
        "title": c.doc["title"],
        "blockCount": len(_blocks(c.doc)),
        "outline": trim(get_outline(c.doc), 1),
    }


def _find_blocks(c: _Ctx) -> Record:  # noqa: C901
    selector: Record = {}
    text = c.get_str("text")
    if text is not None:
        selector["text"] = text
    if c.has("parentId"):
        selector["parentId"] = c.inp["parentId"] if isinstance(c.inp["parentId"], str) else None
    within = c.get_str("within")
    if within is not None:
        _need(c.doc, within, "Container")
        selector["within"] = within
    ids = c.get_list("ids")
    if ids is not None:
        selector["ids"] = [i for i in ids if isinstance(i, str)]
    citation = c.get_str("citationId")
    if citation is not None:
        selector["citationId"] = citation
    if c.has("type"):
        wanted = [c.inp["type"]] if isinstance(c.inp["type"], str) else list(c.inp["type"])
        for w in wanted:
            if w not in BLOCK_TYPES:
                reject(
                    "validation",
                    f'Unknown block type "{w}".',
                    "Use one of: " + ", ".join(BLOCK_TYPES) + ".",
                    path="input.type",
                )
        selector["type"] = wanted
    found = find_blocks(c.doc, selector)
    lim = _int_input(c, "limit", limit("findDefault"))
    offset = _int_input(c, "offset", 0)
    page = found[min(offset, len(found)) : min(offset + lim, len(found))]
    counts = _child_counts(c.doc)
    out: Record = {"ok": True, "revision": c.doc["revision"], "total": len(found), "offset": offset, "count": len(page)}
    if offset + len(page) < len(found):
        out["truncated"] = True
    out["blocks"] = [b if c.inp.get("include") == "content" else _brief(b, counts) for b in page]
    return out


def _get_block(c: _Ctx) -> Record:
    block = _need(c.doc, c.str_or("blockId"), "Block")
    block_id = block["id"]
    counts = _child_counts(c.doc)
    by_id = {b["id"]: b for b in _blocks(c.doc)}
    chain: list[Record] = []
    cursor = block
    for _ in range(len(by_id) + 1):
        parent_id = cursor.get("parentId")
        if not isinstance(parent_id, str) or parent_id not in by_id:
            break
        parent = by_id[parent_id]
        chain.insert(0, _brief(parent, counts))
        cursor = parent
    children = [b["id"] for b in _blocks(c.doc) if b["parentId"] == block_id][: limit("findMax")]
    return {
        "ok": True,
        "revision": c.doc["revision"],
        "block": block,
        "ancestors": chain,
        "children": children,
        "descendantCount": len(descendants_of(c.doc, block_id)),
    }


def _document_stats(c: _Ctx) -> Record:
    return {
        **document_stats(c.doc),
        "ok": True,
        "revision": c.doc["revision"],
        "title": c.doc["title"],
        "updatedAt": c.doc["updatedAt"],
    }


def _list_revisions(c: _Ctx) -> Record:
    everything = list(reversed(c.service.revisions()))
    offset = _int_input(c, "offset", 0)
    lim = _int_input(c, "limit", limit("revisionsDefault"))
    page = everything[min(offset, len(everything)) : min(offset + lim, len(everything))]
    items = []
    for r in page:
        item: Record = {
            "number": r["number"],
            "at": r["at"],
            "actor": r["actor"],
            "kind": r["kind"],
            "transactionId": r["transactionId"],
            "summary": summarize_revision(r),
        }
        if "rebasedFrom" in r:
            item["rebasedFrom"] = r["rebasedFrom"]
        items.append(item)
    return {
        "ok": True,
        "revision": c.doc["revision"],
        "total": len(everything),
        "offset": offset,
        "count": len(page),
        "revisions": items,
    }


def _validate_transaction(c: _Ctx) -> Record:
    parsed = validate_transaction(c.inp.get("transaction"))
    if not parsed["ok"]:
        return {"ok": False, "issues": with_hints(_issues(parsed["issues"])), "currentRevision": c.doc["revision"]}
    result = _scratch_service(c.doc).apply(parsed["value"])
    if not result["ok"]:
        return {"ok": False, "issues": with_hints(result["issues"]), "currentRevision": c.doc["revision"]}
    diff = diff_documents(c.doc, result["document"])
    return {
        "ok": True,
        "valid": True,
        "revision": c.doc["revision"],
        "revisionAfter": result["document"]["revision"],
        "added": list(diff["added"]),
        "removed": list(diff["removed"]),
        "changed": list(diff["changed"]),
        "moved": list(diff["moved"]),
    }


def _issues(issues: list[Record]) -> list[Record]:
    return [{k: i[k] for k in ("code", "message", "path", "hint") if i.get(k)} for i in issues]


def _insert_blocks(c: _Ctx) -> Record:
    markdown = c.get_str("markdown")
    given = c.get_list("blocks")
    if (markdown is not None) == (given is not None):
        reject(
            "validation",
            "Provide exactly one of markdown or blocks.",
            "Send either a markdown string or an array of blocks, not both.",
            path="input",
        )
    after_id = c.nullable("afterId")
    if markdown is not None:
        blocks = _markdown_blocks(c, markdown, c.nullable("parentId"), c.get_str("idPrefix"))
        return _commit(c, _insert_operations(blocks, after_id), path=_generated_path(blocks), verb="inserted")
    assert given is not None
    return _commit(c, _insert_operations([_normalize_block(g) for g in given], after_id), verb="inserted")


def _update_block_text(c: _Ctx) -> Record:
    block = _need(c.doc, c.str_or("blockId"), "Block")
    content = _rewrite_text(block, c.str_or("text"), c.inp.get("format") == "plain")
    op = {
        "type": "updateBlock",
        "blockId": block["id"],
        "expectedVersion": c.get_num("expectedVersion") or 0,
        "content": content,
    }
    return _commit(c, [op], path=lambda _p: "input.text")


def _update_block(c: _Ctx) -> Record:
    op: Record = {
        "type": "updateBlock",
        "blockId": c.str_or("blockId"),
        "expectedVersion": c.get_num("expectedVersion") or 0,
        "content": c.inp.get("content"),
    }
    ids = c.get_list("citationIds")
    if ids is not None:
        op["citationIds"] = ids
    return _commit(c, [op])


def _replace_text(c: _Ctx) -> Record:  # noqa: C901
    find, replace = c.str_or("find"), c.str_or("replace")
    all_matches = c.get_bool("all")
    all_matches = True if all_matches is None else all_matches
    case_sensitive = c.get_bool("caseSensitive")

    def options(op: Record) -> Record:
        op["all"] = all_matches
        if case_sensitive is not None:
            op["caseSensitive"] = case_sensitive
        return op

    block_id = c.get_str("blockId")
    if block_id is not None:
        version = c.get_num("expectedVersion")
        if version is None:
            reject(
                "validation",
                "expectedVersion is required when blockId is given.",
                "Read the block with get_block and send its version.",
                path="input.expectedVersion",
                blockId=block_id,
            )
        _need(c.doc, block_id, "Block")
        op = options(
            {"type": "replaceText", "blockId": block_id, "expectedVersion": version, "find": find, "replace": replace}
        )
        return _commit(c, [op])
    if c.has("expectedVersion"):
        reject(
            "validation",
            "expectedVersion only applies together with blockId.",
            "Remove expectedVersion, or add blockId to edit a single block.",
            path="input.expectedVersion",
        )
    pool = _blocks(c.doc)
    within = c.get_str("within")
    if within is not None:
        _need(c.doc, within, "Container")
        pool = descendants_of(c.doc, within)
    candidates = [b for b in pool if _has_text(b, find, bool(case_sensitive))]
    if not candidates:
        sense = "is" if case_sensitive else "is not"
        reject(
            "not-found",
            f'No block contains "{_preview(find)}".',
            f"Matching {sense} case-sensitive. Use find_blocks with text to locate the wording first.",
            path="input.find",
        )
    if len(candidates) > limit("operations"):
        reject(
            "validation",
            f"{len(candidates)} blocks match; one call can edit at most {limit('operations')}.",
            "Narrow the search with within or blockId.",
            path="input.find",
        )
    ops = [
        options(
            {
                "type": "replaceText",
                "blockId": b["id"],
                "expectedVersion": b["version"],
                "find": find,
                "replace": replace,
            }
        )
        for b in candidates
    ]
    return _commit(c, ops, extra={"matchedBlocks": len(candidates)})


def _move_blocks(c: _Ctx) -> Record:
    op: Record = {"type": "moveBlocks", "blocks": c.inp.get("blocks"), "parentId": c.inp.get("parentId")}
    if c.has("afterId"):
        op["afterId"] = c.inp["afterId"]
    return _commit(c, [op])


def _delete_blocks(c: _Ctx) -> Record:
    return _commit(c, [{"type": "deleteBlocks", "blocks": c.inp.get("blocks")}])


def _add_chart(c: _Ctx) -> Record:
    block_id = c.get_str("id") or _create_block_id("chart", _reserved_ids(c.doc))
    parent = c.nullable("parentId")
    block = {
        "id": block_id,
        "parentId": None if parent is _ABSENT else parent,
        "content": {"type": "chart", "spec": c.inp.get("spec")},
        "citationIds": c.get_list("citationIds") or [],
    }
    return _commit(
        c,
        _insert_operations([block], c.nullable("afterId")),
        verb="inserted",
        extra={"blockId": block_id},
        path=lambda p: p.replace("input.blocks[0].content.spec", "input.spec", 1),
    )


def _add_citation(c: _Ctx) -> Record:
    citation_id = c.get_str("id")
    if citation_id is None:
        citation_id = _create_block_id("src", {ci["id"] for ci in c.doc.get("citations") or []})
    citation: Record = {
        "id": citation_id,
        "title": c.str_or("title"),
        "url": c.str_or("url"),
        "accessedAt": c.get_str("accessedAt") or c.now(),
    }
    if c.has("publishedAt"):
        citation["publishedAt"] = c.str_or("publishedAt")
    operations: list[Any] = [{"type": "addCitation", "citation": citation}]
    block_id = c.get_str("blockId")
    if block_id is not None:
        version = c.get_num("expectedVersion")
        if version is None:
            reject(
                "validation",
                "expectedVersion is required when blockId is given.",
                "Read the block with get_block and send its version.",
                path="input.expectedVersion",
                blockId=block_id,
            )
        block = _need(c.doc, block_id, "Block")
        content = _content(block)
        if c.get_bool("marker"):
            kind = content["type"]
            if kind not in ("paragraph", "quote", "callout"):
                reject(
                    "validation",
                    f"A {kind} block has no inline text for a citation marker.",
                    "Remove marker, or target a paragraph, quote or callout.",
                    path="input.marker",
                    blockId=block_id,
                )
            content = {**content, "runs": [*(content.get("runs") or []), {"text": "", "citationId": citation_id}]}
        ids = list(dict.fromkeys([*(block.get("citationIds") or []), citation_id]))
        operations.append(
            {
                "type": "updateBlock",
                "blockId": block_id,
                "expectedVersion": version,
                "content": content,
                "citationIds": ids,
            }
        )
    return _commit(c, operations, extra={"citationId": citation_id})


def _set_title(c: _Ctx) -> Record:
    return _commit(c, [{"type": "setTitle", "title": c.str_or("title")}])


def _insert_template(c: _Ctx) -> Record:
    kind = c.str_or("kind")
    reserved = _reserved_ids(c.doc)
    prefix = c.get_str("idPrefix")
    if prefix is None:
        prefix = kind
        n = 2
        while any(r.startswith(prefix + "-") for r in reserved):
            prefix = f"{kind}{n}"
            n += 1
    subject_raw = c.str_or("subject")
    parent = c.nullable("parentId")
    parent_id = None if parent is _ABSENT else parent
    try:
        blocks = create_template(kind, prefix, clean_subject(subject_raw), parent_id)
    except ValueError as error:
        reject("validation", str(error), path="input")
    operations: list[Any] = []
    if c.get_bool("setTitle"):
        operations.append({"type": "setTitle", "title": template_title(kind, subject_raw)})
    operations.extend(_insert_operations(blocks, c.nullable("afterId")))
    roots = [b["id"] for b in blocks if b["parentId"] == parent_id]
    return _commit(c, operations, verb="inserted", extra={"idPrefix": prefix, "rootIds": roots})


_JS_WS = "\t\n\x0b\x0c\r \xa0  -     　﻿"
# /^\s*#\s+(.+?)\s*#*\s*$/m, with the line terminators other than \n mapped to \n first so re.M agrees with JavaScript.
_TITLE = re.compile(rf"^[{_JS_WS}]*#[{_JS_WS}]+([^\n]+?)[{_JS_WS}]*#*[{_JS_WS}]*$", re.M)


def _leading_title(markdown: str) -> str | None:
    first = next((ln for ln in markdown.split("\n") if js_trim(ln) != ""), "")
    for terminator in ("\r", " ", " "):
        first = first.replace(terminator, "\n")
    match = _TITLE.search(first)
    if match is None or not match.group(1):
        return None
    return _utf16_prefix(match.group(1), limit("title"))


def _import_markdown(c: _Ctx) -> Record:
    replace = c.inp.get("mode") == "replace"
    if replace and (c.has("afterId") or c.has("parentId")):
        reject(
            "validation",
            'afterId and parentId only apply to mode "append".',
            'Remove them, or use mode "append".',
            path="input.mode",
        )
    markdown = c.str_or("markdown")
    blocks = _markdown_blocks(c, markdown, c.nullable("parentId"), c.get_str("idPrefix"))
    operations: list[Any] = []
    if c.get_bool("setTitle"):
        title = _leading_title(markdown)
        if title is not None:
            operations.append({"type": "setTitle", "title": title})
    if replace:
        roots = [b for b in _blocks(c.doc) if b["parentId"] is None]
        per = limit("blocksPerOperation")
        for start in range(0, len(roots), per):
            refs = [{"blockId": b["id"], "expectedVersion": b["version"]} for b in roots[start : start + per]]
            operations.append({"type": "deleteBlocks", "blocks": refs})
    after_id = _ABSENT if replace else c.nullable("afterId")
    operations.extend(_insert_operations(blocks, after_id))
    return _commit(
        c, operations, path=_generated_path(blocks), verb="imported", extra={"mode": "replace" if replace else "append"}
    )


HANDLERS: dict[str, Handler] = {
    "get_outline": _get_outline,
    "find_blocks": _find_blocks,
    "get_block": _get_block,
    "document_stats": _document_stats,
    "export_markdown": _export("markdown", lambda d, title, _s: to_markdown(d, title=title)),
    "export_html": _export("html", lambda d, title, standalone: to_html(d, title=title, standalone=standalone)),
    "export_text": _export("text", lambda d, title, _s: to_plain_text(d, title=title)),
    "list_revisions": _list_revisions,
    "list_templates": lambda c: {
        "ok": True,
        "revision": c.doc["revision"],
        "templates": _copy(spec().template_infos),
    },
    "validate_transaction": _validate_transaction,
    "insert_blocks": _insert_blocks,
    "update_block_text": _update_block_text,
    "update_block": _update_block,
    "replace_text": _replace_text,
    "move_blocks": _move_blocks,
    "delete_blocks": _delete_blocks,
    "add_chart": _add_chart,
    "add_citation": _add_citation,
    "set_title": _set_title,
    "insert_template": _insert_template,
    "import_markdown": _import_markdown,
}


def _copy(value: Any) -> Any:
    if isinstance(value, list):
        return [_copy(e) for e in value]
    if isinstance(value, dict):
        return {k: _copy(e) for k, e in value.items()}
    return value


def _run(service: Service, action: Action, value: Any, context: Context) -> Record:
    try:
        copied = plain_copy({} if value is None else value, "input")
        if not isinstance(copied, dict):
            reject("validation", "Input must be a JSON object.", "Send the arguments as an object.", path="input")
        check(action.input_schema, copied, "input", action.input_schema)
        dry_run = action.access == "write" and copied.get("dryRun") is True
        target = _scratch_service(service.read()) if dry_run else service
        out = HANDLERS[action.name](_Ctx(target, context, copied, action.name))
        if dry_run and out.get("ok") is True:
            revision = out.pop("revision")
            out.update({"ok": True, "revision": service.read()["revision"], "revisionAfter": revision, "dryRun": True})
        return out
    except ActionIssue as caught:
        return failure(service, [caught.issue])
    except Exception:  # noqa: BLE001 - an action must never raise
        return failure(
            service,
            [
                {
                    "code": "validation",
                    "message": "The action could not be completed safely.",
                    "hint": "Check the input against the action schema and retry.",
                }
            ],
        )


def run_action(service: Service, name: str, value: Any = None, context: Context | None = None) -> Record:
    """Run one action by name over a service. It never raises: unknown names, bad input and Core rejections all return
    {"ok": False, "issues": ..., "currentRevision": ...}."""
    action = spec().action_by_name.get(name)
    if action is None:
        names = ", ".join(a.name for a in spec().actions)
        return failure(
            service,
            [{"code": "not-found", "message": f'Unknown action "{name}".', "hint": f"Available actions: {names}."}],
        )
    return _run(service, action, value, context or Context())


__all__ = ["Context", "Service", "child_index", "failure", "is_template_kind", "run_action"]
